// server.js
// Backend unificado: Express (API + estático), MySQL, MQTT, WhatsApp (Baileys)

const path = require('path');
const fs = require('fs');
const express = require('express');
const mysql = require('mysql2/promise');
const mqtt = require('mqtt');
const cors = require('cors');
const P = require('pino');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason
} = require('baileys');

let lastQR = null;

// ====== Config por ENV (com defaults úteis) ======
const {
  PORT = '4000',

  DB_HOST = 'perspex.ddns.net',
  DB_PORT = '3306',
  DB_USER = 'root',
  DB_PASS = 'RunicK137',
  DB_NAME = 'painelSolar',

  MQTT_URL = 'mqtt://aws21.ddns.net:1883',
  MQTT_PINS_TOPIC = 'iot/painel/pins',

  // Diretório persistente para a sessão do Baileys (montado via volume)
  AUTH_DIR = '/data/baileys_auth_info',

  LOG_LEVEL = 'debug'
} = process.env;

// 1. ADICIONA NOVO TÓPICO À LISTA
const MQTT_TOPICS = [
  'iot/painel/INA226',
  'iot/painel/TSL2591',
  'iot/painel/AHT20',
  'iot/painel/irradiance' // 🚨 NOVO TÓPICO
];

const logger = P({ level: LOG_LEVEL });

// ====== App Express ======
const app = express();
app.use(cors());
app.use(express.json());

// Serve a pasta pública (HTML, JS, CSS)
app.use(express.static(path.join(__dirname, 'public')));

// ====== MySQL (pool) ======
let pool;
async function initDb() {
  pool = await mysql.createPool({
    host: DB_HOST,
    port: Number(DB_PORT),
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    connectionLimit: 10,
    supportBigNumbers: true,
    dateStrings: true
  });

  // Garante a tabela
  const createSql = `
    CREATE TABLE IF NOT EXISTS readings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      voltage DOUBLE NULL,
      current_mA DOUBLE NULL,
      power_mW DOUBLE NULL,
      lux DOUBLE NULL,
      temperature DOUBLE NULL,
      humidity DOUBLE NULL,
      irradiance DOUBLE NULL,  -- 🚨 NOVA COLUNA
      INDEX idx_ts (ts)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  await pool.query(createSql);
  logger.info('🗄️  Tabela "readings" pronta.');
}

// ====== Estado atual (últimos valores) ======
const state = {
  voltage: null,       // V
  current_mA: null,    // mA
  power_mW: null,      // mW
  lux: null,           // lux
  temperature: null,   // °C
  humidity: null,      // %
  irradiance: null     // 🚨 NOVO ESTADO
};

// ====== MQTT ======
let mqttClient;
function initMqtt() {
  mqttClient = mqtt.connect(MQTT_URL);

  mqttClient.on('connect', () => {
    logger.info({ MQTT_URL }, '📡 Conectado ao broker MQTT');
    mqttClient.subscribe(MQTT_TOPICS, (err) => {
      if (err) logger.error(err, 'Erro ao assinar tópicos MQTT');
      else logger.info({ topics: MQTT_TOPICS }, '📥 Inscrito nos tópicos');
    });
  });

  mqttClient.on('message', async (topic, payloadBuf) => {
    const str = payloadBuf.toString().trim();
    let data;
    try { data = JSON.parse(str); } catch { return; }

    if (topic === 'iot/painel/INA226') {
      // Espera { voltage: <V>, current: <A>, power: <W> }
      if (typeof data.voltage === 'number') state.voltage = data.voltage;
      if (typeof data.current === 'number') state.current_mA = data.current; // A -> mA
      if (typeof data.power   === 'number') state.power_mW   = data.power; // W -> mW
    } else if (topic === 'iot/painel/TSL2591') {
      // Espera { lux: <lux> }
      let lux = data.lux;
      if (lux === null || lux === undefined) lux = 0; // força 0 se vier null
      if (typeof lux === 'number') state.lux = lux;
    } else if (topic === 'iot/painel/AHT20') {
      // Espera { temperature: <C>, humidity: <percent> }
      if (typeof data.temperature === 'number') state.temperature = data.temperature;
      if (typeof data.humidity    === 'number') state.humidity    = data.humidity;
    } else if (topic === 'iot/painel/irradiance') { // 🚨 NOVA LÓGICA DE MENSAGEM
      // Espera { irradiance: <W/m²> }
      if (typeof data.irradiance === 'number') state.irradiance = data.irradiance;
    } else {
      return; // ignora outros tópicos
    }

    // Insere snapshot
    try {
      const insertSql = `
        INSERT INTO readings (voltage, current_mA, power_mW, lux, temperature, humidity, irradiance)
        VALUES (?, ?, ?, ?, ?, ?, ?) -- 🚨 ADICIONADO NOVO VALOR
      `;
      const vals = [
        state.voltage,
        state.current_mA,
        state.power_mW,
        state.lux === null ? 0 : state.lux,
        state.temperature,
        state.humidity,
        state.irradiance  // 🚨 ADICIONADO À LISTA DE VALORES
      ];
      await pool.query(insertSql, vals);
      // logger.debug({ vals }, 'Leitura salva');
    } catch (e) {
      logger.error(e, 'Erro ao inserir leitura');
    }
  });
}

// ====== API /api/readings ======
const ALLOWED_METRICS = new Set(['voltage','current_mA','power_mW','lux','temperature','humidity','irradiance']); // 🚨 ATUALIZA PERMISSÕES

function toMysqlDateTimeUTC(isoStr) {
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid ISO: ' + isoStr);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

app.get('/api/readings', async (req, res) => {
  try {
    const { metric, start, end } = req.query;
    if (!metric || !ALLOWED_METRICS.has(String(metric))) {
      return res.status(400).json({ error: 'Parâmetro "metric" inválido.' });
    }
    if (!start || !end) {
      return res.status(400).json({ error: 'Parâmetros "start" e "end" são obrigatórios (ISO).' });
    }

    const startUtc = toMysqlDateTimeUTC(start); // ex.: '2025-08-19 08:20:00'
    const endUtc   = toMysqlDateTimeUTC(end);

    // Converte a coluna ts para UTC e filtra no intervalo;
    // também ignora valores NULL e limita linhas (evita gráfico “lotado”)
    const sql = `
      SELECT ts, \`${metric}\` AS value
      FROM readings
      WHERE \`${metric}\` IS NOT NULL
        AND CONVERT_TZ(ts, @@session.time_zone, '+00:00')
             BETWEEN ? AND ?
      ORDER BY ts ASC
      LIMIT 50000
    `;
    const [rows] = await pool.query(sql, [startUtc, endUtc]);

    const data = rows.map(r => ({
      ts: new Date(r.ts).toISOString(),         // volta em ISO/UTC para o front
      [metric]: r.value !== null ? Number(r.value) : null
    }));
    res.json(data);
  } catch (err) {
    logger.error(err, 'Erro /api/readings');
    res.status(500).json({ error: 'Erro interno ao consultar o banco.' });
  }
});

// ====== WhatsApp (Baileys) ======
async function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

async function startSock() {
  await ensureDir(AUTH_DIR);
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  logger.info(`✅ Usando WhatsApp Web v${version.join('.')}`);

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: false,
  });

  sock.ev.process(async (events) => {
    // Conexão
    if (events['connection.update']) {
      const update = events['connection.update'];
      const { connection, lastDisconnect, qr } = update;

      // Se chegou um QR novo, guarda e mostra
      if (qr) {
        lastQR = qr;
        // imprime no terminal em ASCII (para docker logs)
        qrcodeTerminal.generate(qr, { small: true });
        logger.info('📱 QR atualizado — acesse http://localhost:3000/qr para escanear.');
      }

      if (connection === 'open') {
        // logado, limpa QR
        lastQR = null;
        logger.info('✅ WhatsApp conectado.');
      }

      if (connection === 'close') {
        const shouldReconnect =
          (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
        logger.info(shouldReconnect ? '🔄 Reconectando...' : '❌ Desconectado. Faça login novamente.');
        if (shouldReconnect) startSock();
      }

      if (connection) logger.info({ connection }, '🔌 Status da conexão');
    }
    if (events['creds.update']) {
      await saveCreds();
    }

    // Mensagens
    if (events['messages.upsert']) {
      const upsert = events['messages.upsert'];
      if (upsert.type !== 'notify') return;

      for (const m of upsert.messages) {
        const remoteJid = m.key.remoteJid;
        const isGroup = remoteJid?.endsWith('@g.us');
        // if (isGroup) continue; // opcional: ignora grupos

        const text =
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          m.message?.imageMessage?.caption ||
          '';

        const cmd = (text || '').trim().toLowerCase();
        
        logger.info(`📨 Mensagem recebida de ${remoteJid}`);
        
        // #status => últimos 5
        if (cmd === '#status') {
          try {
            const q = `
              SELECT DATE_FORMAT(ts, '%Y-%m-%d %H:%i:%s') AS ts,
                      voltage, current_mA, power_mW, lux, temperature, humidity, irradiance
              FROM readings
              ORDER BY ts DESC
              LIMIT 1
            `;
            const [rows] = await pool.query(q);

            if (!rows || rows.length === 0) {
              await sock.sendMessage(remoteJid, { text: '📭 Ainda não há leituras registradas.' });
              continue;
            }

            const fmt = (v, suf) =>
              v === null || v === undefined ? '--' : `${Number(v).toFixed(2)}${suf}`;

            const lines = rows.map(r => [
              `🕒 ${r.ts}`,
              `Tensão: ${fmt(r.voltage, ' V')}`,
              `Corrente: ${fmt(r.current_mA, ' mA')}`,
              `Potência: ${fmt(r.power_mW, ' mW')}`,
              `Luminosidade: ${fmt(r.lux, ' lux')}`,
              `Temperatura: ${fmt(r.temperature, ' °C')}`,
              `Umidade: ${fmt(r.humidity, ' %')}`,
              `Irradiância: ${fmt(r.irradiance, ' W/m²')}` // 🚨 ADICIONADO AO RELATÓRIO DO STATUS
            ].join('\n'));

            const reply = `📊 Última leitura:\n\n${lines.join('\n\n')}`;
            await sock.sendMessage(remoteJid, { text: reply });
          } catch (err) {
            logger.error(err, 'Erro ao consultar/env #status');
            await sock.sendMessage(remoteJid, { text: '❌ Erro ao consultar o banco.' });
          }
          continue;
        }

        // #limpezaOn
        if (cmd === '#limpezaon') {
          const payload = JSON.stringify({ GPIO23: 'high' });
          mqttClient.publish(MQTT_PINS_TOPIC, payload, { qos: 1 }, async (err) => {
            if (err) {
              logger.error(err, 'Erro ao publicar #limpezaOn');
              await sock.sendMessage(remoteJid, { text: '❌ Falha ao enviar comando de limpeza ON.' });
            } else {
              logger.info({ topic: MQTT_PINS_TOPIC, payload }, '🧼 MQTT publicado');
              await sock.sendMessage(remoteJid, { text: '✅ Limpeza ON enviada.' });
            }
          });
          continue;
        }

        // #limpezaOff
        if (cmd === '#limpezaoff') {
          const payload = JSON.stringify({ GPIO23: 'low' });
          mqttClient.publish(MQTT_PINS_TOPIC, payload, { qos: 1 }, async (err) => {
            if (err) {
              logger.error(err, 'Erro ao publicar #limpezaOff');
              await sock.sendMessage(remoteJid, { text: '❌ Falha ao enviar comando de limpeza OFF.' });
            } else {
              logger.info({ topic: MQTT_PINS_TOPIC, payload }, '🧽 MQTT publicado');
              await sock.sendMessage(remoteJid, { text: '✅ Limpeza OFF enviada.' });
            }
          });
          continue;
        }
      }
    }
  });

  return sock;
}

// ====== Bootstrap ======
(async () => {
  await initDb();
  initMqtt();
  startSock().catch(e => logger.error(e, 'Erro ao iniciar WhatsApp'));

  app.get('/qr', async (req, res) => {
    try {
      if (!lastQR) {
        res.status(200).send(`
          <html><body style="font-family:ui-sans-serif,system-ui">
            <h2>WhatsApp — QR</h2>
            <p>Nenhum QR ativo no momento. Se o app estiver desconectado, aguarde alguns segundos e recarregue.</p>
            <p><a href="/">Voltar</a></p>
          </body></html>
        `);
        return;
      }
      const dataUrl = await QRCode.toDataURL(lastQR, { scale: 8, margin: 1 });
      res.status(200).send(`
        <html><body style="font-family:ui-sans-serif,system-ui; text-align:center;">
          <h2>Escaneie o QR no WhatsApp</h2>
          <img src="${dataUrl}" alt="WhatsApp QR" />
          <p>Abra o WhatsApp > Dispositivos conectados > Conectar dispositivo</p>
          <p><a href="/">Voltar</a></p>
        </body></html>
      `);
    } catch (e) {
      res.status(500).send('Erro ao gerar QR.');
    }
  });

  app.listen(Number(PORT), () => {
    logger.info(`🚀 Server web em http://localhost:${PORT}`);
    logger.info(`API:     GET /api/readings?metric=voltage&start=ISO&end=ISO`);
    logger.info(`Estático: /  (gráfico)`);
  });
})();