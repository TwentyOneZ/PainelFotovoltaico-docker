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

// ====== Config.ini (leitura/criação) ======
const CONFIG_INI_PATH = path.join(__dirname, 'config.ini');

const defaultIniContent = `# Configurações do painel fotovoltaico e backend
# Gerado automaticamente se não existir.

[pv]
voc0 = 22.06
isc0 = 0.70
vmp0 = 18.81
imp0 = 0.63
alphav = -0.31        # [%/°C] - será dividido por 100 no código
alphai = 0.06         # [%/°C] - será dividido por 100 no código
G0 = 1000
T0 = 25
q = 1.602e-19
kConst = 1.3806503e-23
Ns = 36

[app]
PORT = 4000

DB_HOST = painel-mysql
DB_PORT = 3306
DB_USER = root
DB_PASS = RunicK137
DB_NAME = painelSolar

MQTT_URL = mqtt://cerise.freeddns.org:30001
MQTT_USER = infinitwin_user
MQTT_PASS = IwtLab#2025!
MQTT_PINS_TOPIC = /painelfotovoltaico.gerador/GPIO

AUTH_DIR = /data/baileys_auth_info
LOG_LEVEL = debug

GPIO_THING_ID = painelfotovoltaico.gerador:GPIO
MQTT_ESTIMATED_POWER_TOPIC = /painelfotovoltaico.referencia/estimatedPower
ESTIMATED_POWER_THING_ID = painelfotovoltaico.node:estimatedPower
`;

// Cria config.ini com defaults, se não existir
if (!fs.existsSync(CONFIG_INI_PATH)) {
  fs.writeFileSync(CONFIG_INI_PATH, defaultIniContent, 'utf8');
}

// Parser simples de INI com seções
function parseIni(str) {
  const result = {};
  let section = null;
  const lines = str.split(/\r?\n/);

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1).trim();
      if (!result[section]) result[section] = {};
    } else {
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (section) {
        result[section][key] = value;
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

// Gera um INI simples a partir do objeto em memória (iniConfig)
function buildIni(obj) {
  const lines = [
    '# Arquivo gerado automaticamente. Edite com cuidado.',
    ''
  ];

  for (const [sectionName, section] of Object.entries(obj)) {
    lines.push(`[${sectionName}]`);
    for (const [key, value] of Object.entries(section)) {
      lines.push(`${key} = ${value}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

const iniRaw = fs.readFileSync(CONFIG_INI_PATH, 'utf8');
const iniConfig = parseIni(iniRaw);
const pvCfg = iniConfig.pv || {};
const appCfg = iniConfig.app || {};

const numOr = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

// ====== Config por ENV (com defaults vindos do config.ini) ======
const {
  PORT = appCfg.PORT || '4000',

  DB_HOST = appCfg.DB_HOST || 'perspex.ddns.net',
  DB_PORT = appCfg.DB_PORT || '3306',
  DB_USER = appCfg.DB_USER || 'root',
  DB_PASS = appCfg.DB_PASS || 'RunicK137',
  DB_NAME = appCfg.DB_NAME || 'painelSolar',

  // broker Ditto
  MQTT_URL = appCfg.MQTT_URL || 'mqtt://cerise.freeddns.org:30001',
  MQTT_USER = appCfg.MQTT_USER || 'infinitwin_user',
  MQTT_PASS = appCfg.MQTT_PASS || 'IwtLab#2025!',
  MQTT_PINS_TOPIC = appCfg.MQTT_PINS_TOPIC || '/painelfotovoltaico.gerador/GPIO',

  // Diretório persistente para a sessão do Baileys (montado via volume)
  AUTH_DIR = appCfg.AUTH_DIR || '/data/baileys_auth_info',

  LOG_LEVEL = appCfg.LOG_LEVEL || 'debug'
} = process.env;

// Demais constantes que também podem vir do INI
const GPIO_THING_ID = appCfg.GPIO_THING_ID || 'painelfotovoltaico.gerador:GPIO';

// Tópico para publicar potência estimada (padrão Ditto)
const MQTT_ESTIMATED_POWER_TOPIC =
  appCfg.MQTT_ESTIMATED_POWER_TOPIC || '/painelfotovoltaico.referencia/estimatedPower';
const ESTIMATED_POWER_THING_ID =
  appCfg.ESTIMATED_POWER_THING_ID || 'painelfotovoltaico.node:estimatedPower';

// Tópicos Ditto (eventos) a serem assinados
const MQTT_TOPICS = [
  '/ditto/events/painelfotovoltaico.gerador/GPIO',
  '/ditto/events/painelfotovoltaico.gerador/INA226',
  '/ditto/events/painelfotovoltaico.gerador/TSL2591',
  '/ditto/events/painelfotovoltaico.gerador/BMP280',
  '/ditto/events/painelfotovoltaico.gerador/AHT20',
  '/ditto/events/painelfotovoltaico.referencia/esp32',
  '/ditto/events/painelfotovoltaico.referencia/estimatedPower',
  '/ditto/events/painelFotovoltaico.node/pvConfig'
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
      irradiance DOUBLE NULL,
      estimatedPower DOUBLE NULL,
      INDEX idx_ts (ts)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  await pool.query(createSql);
  logger.info('🗄️  Tabela "readings" pronta.');
}

// ====== Estado atual (últimos valores) ======
const state = {
  voltage: null,
  current_mA: null,
  power_mW: null,
  lux: null,
  temperature: null,     // AHT20
  humidity: null,
  irradiance: null,      // referência (esp32)
  estimatedPower: null
};

// ====== Parâmetros do módulo FV (vindos do config.ini) ======
let voc0 = numOr(pvCfg.voc0, 22.06);
let isc0 = numOr(pvCfg.isc0, 0.70);
let vmp0 = numOr(pvCfg.vmp0, 18.81);
let imp0 = numOr(pvCfg.imp0, 0.63);

// Mantemos kv e ki derivados
let kv = vmp0 / voc0;
let ki = imp0 / isc0;

// alphav e alphai em %/°C no INI, convertidos para fração
let alphav = numOr(pvCfg.alphav, -0.31) / 100;
let alphai = numOr(pvCfg.alphai, 0.06) / 100;

let G0     = numOr(pvCfg.G0, 1000);
let T0     = numOr(pvCfg.T0, 25);
let q      = numOr(pvCfg.q, 1.602e-19);
let kConst = numOr(pvCfg.kConst, 1.3806503e-23);
let Ns     = numOr(pvCfg.Ns, 36);


let contadorIncompleto = 0;

// ====== MQTT ======
let mqttClient;

// flag para controlar se entrou dado no último segundo
let receivedSinceLastTick = false;

/**
 * Calcula a potência estimada com base em state.temperature (AHT20),
 * state.irradiance (esp32 referência) e state.voltage (INA226),
 * e publica em /painelfotovoltaico.referencia/estimatedPower
 * no formato Ditto.
 * Escala: W (V * A)
 */
function calculateEstimatedPowerFromState() {
  const T = state.temperature;   // °C
  let G = state.irradiance;      // W/m²
  const V = state.voltage;       // V

  if (T == null || G == null || V == null) {
    contadorIncompleto += 1;
    logger.debug(
      { contadorIncompleto, T, G, V },
      '⚠️ Dados incompletos para calcular potência estimada.'
    );
    return;
  }

  try {
    // Corrige valor de G caso seja negativo
    G = Math.max(G, 0);

    // Cálculo conforme código Python
    const Vt = (kConst * (T + 273.15)) / q;

    const voc = Ns * Vt * Math.log(G / G0 + 1e-9) + voc0 * (1 + alphav * (T - T0));
    const isc = isc0 * (G / G0) * (1 + alphai * (T - T0));
    const imp = isc * ki;
    const vmp = voc * kv;

    // Função degrau unitário
    let u1, u2;
    if (V - vmp < 0) {
      u1 = 0;
      u2 = 1;
    } else if (V - vmp > 0) {
      u1 = 1;
      u2 = 0;
    } else {
      u1 = 0.5;
      u2 = 0.5;
    }

    // Parâmetros modelo gêmeo digital PV
    const denomVocVmp2 = Math.pow(voc - vmp, 2);
    const denomImpIsc2 = Math.pow(imp - isc, 2);

    if (denomVocVmp2 === 0 || denomImpIsc2 === 0 || imp === 0) {
      logger.warn(
        {
          voc,
          vmp,
          isc,
          imp,
          denomVocVmp2,
          denomImpIsc2
        },
        '⚠️ Denominador zero no cálculo da potência estimada; pulando.'
      );
      return;
    }

    const a = (imp / denomVocVmp2) * (voc / vmp - 2);
    const b = (-2 * vmp * imp / denomVocVmp2) * (voc / vmp - 2) - imp / vmp;
    const c = (imp * voc) / vmp - (voc * imp * Math.pow(voc - 2 * vmp, 2)) / (vmp * denomVocVmp2);

    const d = (-vmp * (2 * imp - isc)) / (imp * denomImpIsc2);
    const eParam = (2 * vmp * (2 * imp - isc)) / denomImpIsc2 - vmp / imp;
    const f = (vmp * isc * (2 * isc - 3 * imp)) / denomImpIsc2;

    const discriminant = Math.max(eParam * eParam - 4 * d * (f - V), 0);

    const i = (a * V * V + b * V + c) * u1 + (-eParam - Math.sqrt(discriminant)) / (2 * d) * u2;

    const estimatedPower = V * i; // Watts

    if (!Number.isFinite(estimatedPower)) {
      logger.warn(
        { estimatedPower, V, i },
        '⚠️ Potência estimada não finita; não será publicada.'
      );
      return;
    }

    state.estimatedPower = estimatedPower;

    // Publica no tópico Ditto de referência
    if (mqttClient && mqttClient.connected) {
      const payload = JSON.stringify({
        thingId: ESTIMATED_POWER_THING_ID,
        sensorData: {
          estimatedPower: Number(estimatedPower.toFixed(3))
        }
      });

      mqttClient.publish(
        MQTT_ESTIMATED_POWER_TOPIC,
        payload,
        { qos: 1 },
        (err) => {
          if (err) {
            logger.error(
              { err, topic: MQTT_ESTIMATED_POWER_TOPIC, payload },
              '⚠️ Erro ao publicar potência estimada no MQTT.'
            );
          }
        }
      );
    } else {
      logger.warn(
        { connected: mqttClient && mqttClient.connected },
        '⚠️ MQTT não conectado; não foi possível publicar estimatedPower.'
      );
    }
  } catch (ex) {
    logger.error(
      { err: ex },
      '⚠️ Erro no cálculo da potência estimada.'
    );
  }
}

function initMqtt() {
  mqttClient = mqtt.connect(MQTT_URL, {
    username: MQTT_USER,
    password: MQTT_PASS
  });

  mqttClient.on('connect', () => {
    logger.info({ MQTT_URL, MQTT_USER }, '📡 Conectado ao broker MQTT (Ditto)');
    mqttClient.subscribe(MQTT_TOPICS, (err) => {
      if (err) logger.error(err, 'Erro ao assinar tópicos MQTT');
      else logger.info({ topics: MQTT_TOPICS }, '📥 Inscrito nos tópicos Ditto');
    });
  });

  mqttClient.on('error', (err) => {
    logger.error({ err }, 'Erro na conexão MQTT');
  });

  mqttClient.on('message', async (topic, payloadBuf) => {
    const str = payloadBuf.toString('utf8').trim();
    let data;
    try {
      data = JSON.parse(str);
    } catch (e) {
      logger.warn({ topic, payload: str }, 'Payload MQTT não é JSON válido');
      return;
    }

    // Esperamos o formato Ditto:
    // { "namespace":"painelfotovoltaico.gerador"|"painelfotovoltaico.referencia",
    //   "thingId":"INA226"|"AHT20"|"esp32"|...,
    //   "sensorData":{ ... } }
    const isDittoTopic = topic.toLowerCase().startsWith('/ditto/events/painelfotovoltaico.');
    if (!isDittoTopic) {
      return;
    }

    const { thingId, sensorData } = data || {};
    if (!thingId || !sensorData || typeof sensorData !== 'object') {
      logger.warn({ topic, data }, 'Mensagem Ditto sem thingId ou sensorData');
      return;
    }

    // Marcamos que recebemos dado válido nesta janela
    receivedSinceLastTick = true;

    // Atualiza o estado em função do thingId
    try {
      switch (thingId) {
        case 'INA226':
          if (typeof sensorData.voltage === 'number') state.voltage = sensorData.voltage;
          if (typeof sensorData.current === 'number') state.current_mA = sensorData.current;
          if (typeof sensorData.power === 'number') state.power_mW = sensorData.power;
          break;

        case 'TSL2591': {
          let lux = sensorData.lux;
          if (lux === null || lux === undefined) lux = 0;
          if (typeof lux === 'number') state.lux = lux;
          break;
        }

        case 'AHT20':
          if (typeof sensorData.temperature === 'number') state.temperature = sensorData.temperature;
          if (typeof sensorData.humidity === 'number') state.humidity = sensorData.humidity;
          break;

        case 'BMP280':
          // Podemos usar como fonte alternativa de temperatura/pressão no futuro.
          break;

        case 'GPIO':
          logger.info(
            { gpio23: sensorData.GPIO23 },
            'Leitura de GPIO recebida de Ditto (não gravada no banco).'
          );
          break;

        case 'esp32':
          if (typeof sensorData.irradiance === 'number') {
            state.irradiance = sensorData.irradiance;
          }
          break;

        case 'estimatedPower':
          logger.info(
            { sensorData },
            'Mensagem de estimatedPower recebida (ignorada para cálculo, pois é feito localmente).'
          );
          break;

        // ⬇️ NOVO: atualização dinâmica dos parâmetros do PV
        case 'pvConfig': {
          const logBase = {
            namespace: 'painelFotovoltaico.node',
            thingId: 'pvConfig'
          };

          try {
            const fields = [
              'voc0',
              'isc0',
              'vmp0',
              'imp0',
              'alphav',
              'alphai',
              'G0',
              'T0',
              'q',
              'kConst',
              'Ns'
            ];

            const updated = {};
            for (const key of fields) {
              if (sensorData[key] !== undefined) {
                const n = Number(sensorData[key]);
                if (!Number.isFinite(n)) {
                  throw new Error(`Valor inválido para ${key}: ${sensorData[key]}`);
                }
                updated[key] = n;
              }
            }

            if (Object.keys(updated).length === 0) {
              throw new Error('Nenhum campo de PV encontrado em sensorData.');
            }

            // Atualiza variáveis em memória
            if (updated.voc0 !== undefined) voc0 = updated.voc0;
            if (updated.isc0 !== undefined) isc0 = updated.isc0;
            if (updated.vmp0 !== undefined) vmp0 = updated.vmp0;
            if (updated.imp0 !== undefined) imp0 = updated.imp0;

            // Recalcula kv e ki
            kv = vmp0 / voc0;
            ki = imp0 / isc0;

            if (updated.alphav !== undefined) alphav = updated.alphav / 100;
            if (updated.alphai !== undefined) alphai = updated.alphai / 100;
            if (updated.G0 !== undefined) G0 = updated.G0;
            if (updated.T0 !== undefined) T0 = updated.T0;
            if (updated.q !== undefined) q = updated.q;
            if (updated.kConst !== undefined) kConst = updated.kConst;
            if (updated.Ns !== undefined) Ns = updated.Ns;

            // Atualiza objeto iniConfig.pv (será usado para regravar o INI)
            iniConfig.pv = iniConfig.pv || {};
            for (const key of fields) {
              if (updated[key] !== undefined) {
                // No INI guardamos em string (inclui alphav/alphai em %)
                iniConfig.pv[key] = String(updated[key]);
              }
            }

            // Regrava o config.ini (dentro do container e, via volume, fora também)
            const newIni = buildIni(iniConfig);
            fs.writeFileSync(CONFIG_INI_PATH, newIni, 'utf8');

            logger.info({ updated }, 'Parâmetros PV atualizados via pvConfig MQTT.');

            // Publica log de sucesso
            if (mqttClient && mqttClient.connected) {
              const logPayload = JSON.stringify({
                ...logBase,
                status: 'ok',
                message: 'Parâmetros PV atualizados com sucesso.',
                pv: {
                  voc0,
                  isc0,
                  vmp0,
                  imp0,
                  alphav: alphav * 100, // volta para % no log
                  alphai: alphai * 100,
                  G0,
                  T0,
                  q,
                  kConst,
                  Ns
                }
              });

              mqttClient.publish(
                '/ditto/events/painelFotovoltaico.node/pvConfig/log',
                logPayload,
                { qos: 1 },
                (err) => {
                  if (err) {
                    logger.error({ err }, 'Erro ao publicar log de pvConfig (sucesso).');
                  }
                }
              );
            }
          } catch (err) {
            logger.error({ err }, 'Erro ao processar pvConfig');

            if (mqttClient && mqttClient.connected) {
              const logPayload = JSON.stringify({
                ...logBase,
                status: 'error',
                message: err.message || String(err)
              });

              mqttClient.publish(
                '/ditto/events/painelFotovoltaico.node/pvConfig/log',
                logPayload,
                { qos: 1 },
                (pubErr) => {
                  if (pubErr) {
                    logger.error({ pubErr }, 'Erro ao publicar log de pvConfig (erro).');
                  }
                }
              );
            }
          }

          // Nada para gravar no banco para pvConfig, então apenas break
          break;
        }

        default:
          logger.debug({ thingId, sensorData }, 'thingId não mapeado no handler de MQTT');
          break;
      }

      // Tenta calcular/persistir leitura NORMAL (sensores) – não afeta pvConfig
      if (thingId !== 'pvConfig') {
        calculateEstimatedPowerFromState();

        const insertSql = `
          INSERT INTO readings (voltage, current_mA, power_mW, lux, temperature, humidity, irradiance, estimatedPower)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const vals = [
          state.voltage,
          state.current_mA,
          state.power_mW,
          state.lux === null ? 0 : state.lux,
          state.temperature,
          state.humidity,
          state.irradiance,
          state.estimatedPower
        ];
        await pool.query(insertSql, vals);
      }
    } catch (e) {
      logger.error(e, 'Erro ao processar/inserir leitura MQTT (Ditto)');
    }
  });
}

// ====== API /api/readings ======
const ALLOWED_METRICS = new Set([
  'voltage',
  'current_mA',
  'power_mW',
  'lux',
  'temperature',
  'humidity',
  'irradiance',
  'estimatedPower'
]);

// Lista de todas as métricas para exportação
const ALL_METRICS = [
  'voltage',
  'current_mA',
  'power_mW',
  'lux',
  'temperature',
  'humidity',
  'irradiance',
  'estimatedPower'
];

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

    const startUtc = toMysqlDateTimeUTC(start);
    const endUtc = toMysqlDateTimeUTC(end);

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

    const data = rows.map((r) => ({
      ts: new Date(r.ts).toISOString(),
      [metric]: r.value !== null ? Number(r.value) : null
    }));
    res.json(data);
  } catch (err) {
    logger.error(err, 'Erro /api/readings');
    res.status(500).json({ error: 'Erro interno ao consultar o banco.' });
  }
});

// ====== API /api/download (Exportação CSV de todos os dados) ======
app.get('/api/download', async (req, res) => {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: 'Parâmetros "start" e "end" são obrigatórios (ISO).' });
    }

    const startUtc = toMysqlDateTimeUTC(start);
    const endUtc = toMysqlDateTimeUTC(end);

    const columns = ['ts'].concat(ALL_METRICS).map((col) => `\`${col}\``).join(', ');
    const sql = `
      SELECT ${columns}
      FROM readings
      WHERE CONVERT_TZ(ts, @@session.time_zone, '+00:00')
             BETWEEN ? AND ?
      ORDER BY ts ASC
    `;
    const [rows] = await pool.query(sql, [startUtc, endUtc]);

    if (rows.length === 0) {
      return res.status(204).send();
    }

    const headerLabels = ['Instante'].concat(ALL_METRICS);
    const csvHeader = headerLabels.join(';') + '\n';

    const csvData = rows
      .map((row) => {
        const ts = new Date(row.ts).toISOString().replace('T', ' ').slice(0, 19);
        const values = ALL_METRICS.map((metric) => {
          const value = row[metric];
          return value !== null && value !== undefined ? String(Number(value)) : '';
        });
        return [ts].concat(values).join(';');
      })
      .join('\n');

    const csvContent = csvHeader + csvData;

    const filename = `dados_painel_full_${start.slice(0, 10)}_a_${end.slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
  } catch (err) {
    logger.error(err, 'Erro /api/download');
    res.status(500).json({ error: 'Erro interno ao consultar o banco para download.' });
  }
});

// ====== WhatsApp (Baileys) ======
async function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
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
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    generateHighQualityLinkPreview: false
  });

  sock.ev.process(async (events) => {
    // Conexão
    if (events['connection.update']) {
      const update = events['connection.update'];
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        lastQR = qr;
        qrcodeTerminal.generate(qr, { small: true });
        logger.info('📱 QR atualizado — acesse http://localhost:3000/qr para escanear.');
      }

      if (connection === 'open') {
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
        const text =
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          m.message?.imageMessage?.caption ||
          '';

        const cmd = (text || '').trim().toLowerCase();

        logger.info(`📨 Mensagem recebida de ${remoteJid}`);

        if (cmd === '#status') {
          try {
            const q = `
              SELECT DATE_FORMAT(ts, '%Y-%m-%d %H:%i:%s') AS ts,
                      voltage, current_mA, power_mW, lux, temperature, humidity, irradiance, estimatedPower
              FROM readings
              ORDER BY ts DESC
              LIMIT 1
            `;
            const [rows] = await pool.query(q);

            if (!rows || rows.length === 0) {
              await sock.sendMessage(remoteJid, {
                text: '📭 Ainda não há leituras registradas.'
              });
              continue;
            }

            const fmt = (v, suf) =>
              v === null || v === undefined ? '--' : `${Number(v).toFixed(2)}${suf}`;

            const lines = rows.map((r) =>
              [
                `🕒 ${r.ts}`,
                `Tensão: ${fmt(r.voltage, ' V')}`,
                `Corrente: ${fmt(r.current_mA, ' mA')}`,
                `Potência: ${fmt(r.power_mW, ' mW')}`,
                `Luminosidade: ${fmt(r.lux, ' lux')}`,
                `Temperatura: ${fmt(r.temperature, ' °C')}`,
                `Umidade: ${fmt(r.humidity, ' %')}`,
                `Irradiância: ${fmt(r.irradiance, ' W/m²')}`,
                `Pot. Estimada: ${fmt(r.estimatedPower, ' W')}`
              ].join('\n')
            );

            const reply = `📊 Última leitura:\n\n${lines.join('\n\n')}`;
            await sock.sendMessage(remoteJid, { text: reply });
          } catch (err) {
            logger.error(err, 'Erro ao consultar/env #status');
            await sock.sendMessage(remoteJid, { text: '❌ Erro ao consultar o banco.' });
          }
          continue;
        }

        if (cmd === '#limpezaon') {
          const payload = JSON.stringify({
            thingId: GPIO_THING_ID,
            sensorData: { GPIO23: 'high' }   // ligado
          });

          mqttClient.publish(MQTT_PINS_TOPIC, payload, { qos: 1 }, async (err) => {
            if (err) {
              logger.error({ err, topic: MQTT_PINS_TOPIC, payload }, 'Erro ao publicar #limpezaOn');
              await sock.sendMessage(remoteJid, {
                text: '❌ Falha ao enviar comando de limpeza ON.'
              });
            } else {
              logger.info({ topic: MQTT_PINS_TOPIC, payload }, '🧼 MQTT publicado (#limpezaon)');
              await sock.sendMessage(remoteJid, { text: '✅ Limpeza ON enviada.' });
            }
          });
          continue;
        }

        if (cmd === '#limpezaoff') {
          const payload = JSON.stringify({
            thingId: GPIO_THING_ID,
            sensorData: { GPIO23: 'low' }    // desligado
          });

          mqttClient.publish(MQTT_PINS_TOPIC, payload, { qos: 1 }, async (err) => {
            if (err) {
              logger.error({ err, topic: MQTT_PINS_TOPIC, payload }, 'Erro ao publicar #limpezaOff');
              await sock.sendMessage(remoteJid, {
                text: '❌ Falha ao enviar comando de limpeza OFF.'
              });
            } else {
              logger.info({ topic: MQTT_PINS_TOPIC, payload }, '🧽 MQTT publicado (#limpezaoff)');
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
  startSock().catch((e) => logger.error(e, 'Erro ao iniciar WhatsApp'));

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
