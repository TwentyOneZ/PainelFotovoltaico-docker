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
MQTT_PV_CONFIG_CMD_TOPIC = '/painelfotovoltaico.node/pvConfig'
ESTIMATED_POWER_THING_ID = painelfotovoltaico.node:estimatedPower
MQTT_ALL_TOPIC = /painelfotovoltaico.node/all
ALL_THING_ID = painelfotovoltaico.node:all
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
const MQTT_PV_CONFIG_CMD_TOPIC =
  appCfg.MQTT_PV_CONFIG_CMD_TOPIC || '/painelfotovoltaico.node/pvConfig';
const MQTT_ALL_TOPIC = 
  appCfg.MQTT_ALL_TOPIC || '/painelfotovoltaico.node/all';

const ALL_THING_ID = 
  appCfg.ALL_THING_ID || 'painelfotovoltaico.node:all';

// Tópicos Ditto (eventos) a serem assinados
const MQTT_TOPICS = [
  '/ditto/events/painelfotovoltaico.gerador/GPIO',
  '/ditto/events/painelfotovoltaico.gerador/INA226',
  '/ditto/events/painelfotovoltaico.gerador/TSL2591',
  '/ditto/events/painelfotovoltaico.gerador/BMP280',
  '/ditto/events/painelfotovoltaico.gerador/AHT20',
  '/ditto/events/painelfotovoltaico.referencia/esp32',
  '/ditto/events/painelfotovoltaico.referencia/estimatedPower',
  '/ditto/events/painelfotovoltaico.node/pvConfig'
];

const logger = P({ level: LOG_LEVEL });

// ====== App Express ======
const app = express();
app.use(cors());
app.use(express.json());

// Serve a pasta pública (HTML, JS, CSS)
app.use(express.static(path.join(__dirname, 'public')));

// ====== Variável global para gravação de falha ======
let falhaState = 0;

// ====== SISTEMA DE BUFFER DE GRAVAÇÃO ======
const insertBuffer = [];
const BUFFER_INTERVAL_MS = 5000; // Salva o lote no banco de dados a cada 5 segundos

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
  
  // Garante a existência da coluna "falha"
  try {
    await pool.query('ALTER TABLE readings ADD COLUMN falha TINYINT(1) DEFAULT 0');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') {
      logger.error(err, 'Erro ao adicionar coluna falha');
    }
  }

  // Inicializa o falhaState a partir do banco de dados na inicialização
  try {
    const [rows] = await pool.query('SELECT falha FROM readings ORDER BY ts DESC LIMIT 1');
    if (rows.length) falhaState = rows[0].falha || 0;
  } catch (e) {
    logger.error(e, 'Erro ao carregar estado inicial de falha');
  }

  logger.info('🗄️  Tabela "readings" pronta.');

  // Inicia o processo de salvamento em lote (Batch Insert) do Buffer
  setInterval(async () => {
    if (insertBuffer.length === 0) return;
    
    // Extrai e limpa tudo que entrou no buffer nos ultimos 5 segundos
    const batchData = insertBuffer.splice(0, insertBuffer.length);
    
    try {
      const sql = `
        INSERT INTO readings (ts, voltage, current_mA, power_mW, lux, temperature, humidity, irradiance, estimatedPower, falha)
        VALUES ?
      `;
      // O mysql2 aceita um array de arrays para inserções em lote de uma só vez
      await pool.query(sql, [batchData]);
      logger.debug(`Gravou lote de ${batchData.length} leituras no banco.`);
    } catch(err) {
      logger.error(err, 'Erro ao gravar buffer em lote no banco');
    }
  }, BUFFER_INTERVAL_MS);
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

// flag para saber se algum valor mudou desde o último publish /all
let stateChangedSinceLastTick = false;

function publishAllIfChanged() {
  if (!mqttClient || !mqttClient.connected) return;
  if (!stateChangedSinceLastTick) return;

  const payload = {
    thingId: ALL_THING_ID,
    sensorData: {
      voltage: state.voltage,
      current_mA: state.current_mA,
      power_mW: state.power_mW,
      lux: state.lux,
      temperature: state.temperature,
      humidity: state.humidity,
      irradiance: state.irradiance,
      estimatedPower: state.estimatedPower
    }
  };

  mqttClient.publish(
    MQTT_ALL_TOPIC,
    JSON.stringify(payload),
    { qos: 0 },
    (err) => {
      if (err) {
        logger.error({ err, topic: MQTT_ALL_TOPIC, payload }, 'Erro ao publicar estado agregado /all');
      } else {
        logger.debug({ topic: MQTT_ALL_TOPIC }, 'Estado agregado /all publicado.');
      }
    }
  );

  stateChangedSinceLastTick = false;
}

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
    G = Math.max(G, 0);

    const Vt = (kConst * (T + 273.15)) / q;

    const voc = Ns * Vt * Math.log(G / G0 + 1e-9) + voc0 * (1 + alphav * (T - T0));
    const isc = isc0 * (G / G0) * (1 + alphai * (T - T0));
    const imp = isc * ki;
    const vmp = voc * kv;

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

    const denomVocVmp2 = Math.pow(voc - vmp, 2);
    const denomImpIsc2 = Math.pow(imp - isc, 2);

    if (denomVocVmp2 === 0 || denomImpIsc2 === 0 || imp === 0) {
      logger.warn(
        { voc, vmp, isc, imp, denomVocVmp2, denomImpIsc2 },
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

    let estimatedPower = V * i; // Watts
    estimatedPower = Math.max(0, estimatedPower);

    if (!Number.isFinite(estimatedPower)) {
      logger.warn(
        { estimatedPower, V, i },
        '⚠️ Potência estimada não finita; não será publicada.'
      );
      return;
    }

    if (state.estimatedPower !== estimatedPower) {
      state.estimatedPower = estimatedPower;
      stateChangedSinceLastTick = true;
    }

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

    const isDittoTopic = topic.toLowerCase().startsWith('/ditto/events/painelfotovoltaico.');
    if (!isDittoTopic) {
      return;
    }

    const { thingId, sensorData } = data || {};
    if (!thingId || !sensorData || typeof sensorData !== 'object') {
      logger.warn({ topic, data }, 'Mensagem Ditto sem thingId ou sensorData');
      return;
    }

    receivedSinceLastTick = true;

    try {
      switch (thingId) {
        case 'INA226': {
          if (typeof sensorData.voltage === 'number') {
            if (state.voltage !== sensorData.voltage) {
              state.voltage = sensorData.voltage;
              stateChangedSinceLastTick = true;
            }
          }
          if (typeof sensorData.current === 'number') {
            if (state.current_mA !== sensorData.current) {
              state.current_mA = sensorData.current;
              stateChangedSinceLastTick = true;
            }
          }
          if (typeof sensorData.power === 'number') {
            if (state.power_mW !== sensorData.power) {
              state.power_mW = sensorData.power;
              stateChangedSinceLastTick = true;
            }
          }
          break;
        }

        case 'TSL2591': {
          let lux = sensorData.lux;
          if (lux === null || lux === undefined) lux = 0;
          if (typeof lux === 'number') {
            if (state.lux !== lux) {
              state.lux = lux;
              stateChangedSinceLastTick = true;
            }
          }
          break;
        }

        case 'AHT20': {
          if (typeof sensorData.temperature === 'number') {
            if (state.temperature !== sensorData.temperature) {
              state.temperature = sensorData.temperature;
              stateChangedSinceLastTick = true;
            }
          }
          if (typeof sensorData.humidity === 'number') {
            if (state.humidity !== sensorData.humidity) {
              state.humidity = sensorData.humidity;
              stateChangedSinceLastTick = true;
            }
          }
          break;
        }

        case 'BMP280':
          break;

        case 'GPIO':
          logger.info(
            { gpio23: sensorData.GPIO23 },
            'Leitura de GPIO recebida de Ditto (não gravada no banco).'
          );
          break;

        case 'esp32':
          if (typeof sensorData.irradiance === 'number') {
            if (state.irradiance !== sensorData.irradiance) {
              state.irradiance = sensorData.irradiance;
              stateChangedSinceLastTick = true;
            }
          }
          break;

        case 'estimatedPower':
          logger.info(
            { sensorData },
            'Mensagem de estimatedPower recebida (ignorada para cálculo, pois é feito localmente).'
          );
          break;

        case 'pvConfig': {
          const logBase = {
            namespace: 'painelfotovoltaico.node',
            thingId: 'pvConfig'
          };

          try {
            const fields = [
              'voc0', 'isc0', 'vmp0', 'imp0', 'alphav', 'alphai',
              'G0', 'T0', 'q', 'kConst', 'Ns'
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

            if (updated.voc0 !== undefined) voc0 = updated.voc0;
            if (updated.isc0 !== undefined) isc0 = updated.isc0;
            if (updated.vmp0 !== undefined) vmp0 = updated.vmp0;
            if (updated.imp0 !== undefined) imp0 = updated.imp0;

            kv = vmp0 / voc0;
            ki = imp0 / isc0;

            if (updated.alphav !== undefined) alphav = updated.alphav / 100;
            if (updated.alphai !== undefined) alphai = updated.alphai / 100;
            if (updated.G0 !== undefined) G0 = updated.G0;
            if (updated.T0 !== undefined) T0 = updated.T0;
            if (updated.q !== undefined) q = updated.q;
            if (updated.kConst !== undefined) kConst = updated.kConst;
            if (updated.Ns !== undefined) Ns = updated.Ns;

            iniConfig.pv = iniConfig.pv || {};
            for (const key of fields) {
              if (updated[key] !== undefined) {
                iniConfig.pv[key] = String(updated[key]);
              }
            }

            const newIni = buildIni(iniConfig);
            fs.writeFileSync(CONFIG_INI_PATH, newIni, 'utf8');

            logger.info({ updated }, 'Parâmetros PV atualizados via pvConfig MQTT.');

            if (mqttClient && mqttClient.connected) {
              const logPayload = JSON.stringify({
                ...logBase,
                status: 'ok',
                message: 'Parâmetros PV atualizados com sucesso.',
                pv: {
                  voc0, isc0, vmp0, imp0,
                  alphav: alphav * 100,
                  alphai: alphai * 100,
                  G0, T0, q, kConst, Ns
                }
              });

              // # mqttClient.publish(
              // #   '/ditto/events/painelfotovoltaico.node/pvConfig/log',
              // #   logPayload,
              // #   { qos: 1 },
              // #   (err) => {
              // #     if (err) {
              // #       logger.error({ err }, 'Erro ao publicar log de pvConfig (sucesso).');
              // #     }
              // #   }
              // # );
            }
          } catch (err) {
            logger.error({ err }, 'Erro ao processar pvConfig');

            if (mqttClient && mqttClient.connected) {
              const logPayload = JSON.stringify({
                ...logBase,
                status: 'error',
                message: err.message || String(err)
              });

              // # mqttClient.publish(
              // #   '/ditto/events/painelfotovoltaico.node/pvConfig/log',
              // #   logPayload,
              // #   { qos: 1 },
              // #   (pubErr) => {
              // #     if (pubErr) {
              // #       logger.error({ pubErr }, 'Erro ao publicar log de pvConfig (erro).');
              // #     }
              // #   }
              // # );
            }
          }

          break;
        }

        default:
          logger.debug({ thingId, sensorData }, 'thingId não mapeado no handler de MQTT');
          break;
      }

      if (thingId !== 'pvConfig') {
        calculateEstimatedPowerFromState();

        // Em vez de fazer uma transação nova no banco a cada 1 segundo, 
        // guardamos na memória RAM e um intervalo limpa e salva a cada 5s.
        insertBuffer.push([
          new Date(), // ts - Capturamos a hora exata da chegada do dado!
          state.voltage,
          state.current_mA,
          state.power_mW,
          state.lux === null ? 0 : state.lux,
          state.temperature,
          state.humidity,
          state.irradiance,
          state.estimatedPower,
          falhaState
        ]);
      }
    } catch (e) {
      logger.error(e, 'Erro ao processar/inserir leitura MQTT (Ditto)');
    }
  });
}

// ====== API PV CONFIG ======
app.get('/api/pv-config', (req, res) => {
  try {
    res.json({
      voc0, isc0, vmp0, imp0,
      alphav: alphav * 100,
      alphai: alphai * 100,
      G0, T0, q, kConst, Ns
    });
  } catch (err) {
    logger.error(err, 'Erro /api/pv-config (GET)');
    res.status(500).json({ error: 'Erro interno ao obter configuração PV.' });
  }
});

app.post('/api/pv-config', (req, res) => {
  const body = req.body || {};
  const fields = [
    'voc0', 'isc0', 'vmp0', 'imp0', 'alphav', 'alphai',
    'G0', 'T0', 'q', 'kConst', 'Ns'
  ];

  const sensorData = {};
  try {
    for (const key of fields) {
      if (body[key] === undefined) continue;
      const n = Number(body[key]);
      if (!Number.isFinite(n)) {
        return res.status(400).json({ error: `Valor inválido para ${key}.` });
      }
      sensorData[key] = n;
    }

    if (Object.keys(sensorData).length === 0) {
      return res.status(400).json({ error: 'Nenhum parâmetro fornecido.' });
    }

    if (!mqttClient || !mqttClient.connected) {
      return res.status(503).json({ error: 'MQTT não conectado.' });
    }

    const payload = JSON.stringify({
      thingId: 'painelfotovoltaico.node:pvConfig',
      sensorData
    });

    mqttClient.publish(
      MQTT_PV_CONFIG_CMD_TOPIC,
      payload,
      { qos: 1 },
      (err) => {
        if (err) {
          logger.error({ err, payload }, 'Erro ao publicar comando pvConfig');
          return res.status(500).json({ error: 'Falha ao publicar no MQTT.' });
        }

        return res.json({ ok: true });
      }
    );
  } catch (err) {
    logger.error(err, 'Erro /api/pv-config (POST)');
    res.status(500).json({ error: 'Erro interno ao processar configuração PV.' });
  }
});

// ====== API FALHA ======
app.get('/api/falha', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT falha FROM readings ORDER BY ts DESC LIMIT 1');
    const falha = rows.length ? (rows[0].falha || 0) : 0;
    res.json({ falha });
  } catch(err) {
    logger.error(err, 'Erro /api/falha (GET)');
    res.status(500).json({ error: 'Erro ao buscar falha' });
  }
});

app.post('/api/falha', (req, res) => {
  try {
    falhaState = req.body.falha ? 1 : 0;
    res.json({ ok: true, falha: falhaState });
  } catch (err) {
    logger.error(err, 'Erro /api/falha (POST)');
    res.status(500).json({ error: 'Erro ao atualizar falha' });
  }
});

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
  'estimatedPower',
  'falha'
];

function toMysqlDateTimeUTC(isoStr) {
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid ISO: ' + isoStr);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function csvValue(value) {
  if (value === null || value === undefined) return '';

  const str = String(value);
  if (/[;"\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

function csvLine(values) {
  return values.map(csvValue).join(';') + '\n';
}

function formatCsvTimestamp(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

app.get('/api/readings', async (req, res) => {
  try {
    const { metric, start, end, maxPoints: maxPointsRaw } = req.query;

    if (!metric || !ALLOWED_METRICS.has(String(metric))) {
      return res.status(400).json({ error: 'Parâmetro "metric" inválido.' });
    }
    if (!start || !end) {
      return res.status(400).json({ error: 'Parâmetros "start" e "end" são obrigatórios (ISO).' });
    }

    const maxPoints = maxPointsRaw ? parseInt(maxPointsRaw, 10) : null;

    // Os parâmetros em string formatados como UTC (YYYY-MM-DD HH:mm:ss)
    const startUtc = toMysqlDateTimeUTC(start);
    const endUtc   = toMysqlDateTimeUTC(end);

    // OTIMIZAÇÃO CRÍTICA DO SELECT:
    // Convertemos a variável do node (startUtc) para o fuso do banco usando CONVERT_TZ(?), 
    // em vez de converter a coluna ts. Isso permite o banco usar o índice 'idx_ts' instantaneamente.

    if (maxPoints && Number.isFinite(maxPoints) && maxPoints > 0) {
      const countSql = `
        SELECT COUNT(*) AS total
        FROM readings
        WHERE \`${metric}\` IS NOT NULL
          AND ts BETWEEN CONVERT_TZ(?, '+00:00', @@session.time_zone)
                     AND CONVERT_TZ(?, '+00:00', @@session.time_zone)
      `;
      const [countRows] = await pool.query(countSql, [startUtc, endUtc]);
      const totalRows = (countRows && countRows[0] && countRows[0].total) ? Number(countRows[0].total) : 0;

      if (totalRows <= maxPoints) {
        const sqlRaw = `
          SELECT ts, \`${metric}\` AS value
          FROM readings
          WHERE \`${metric}\` IS NOT NULL
            AND ts BETWEEN CONVERT_TZ(?, '+00:00', @@session.time_zone)
                       AND CONVERT_TZ(?, '+00:00', @@session.time_zone)
          ORDER BY ts ASC
        `;
        const [rows] = await pool.query(sqlRaw, [startUtc, endUtc]);

        const data = rows.map((r) => ({
          ts: new Date(r.ts).toISOString(),
          [metric]: r.value !== null ? Number(r.value) : null
        }));
        return res.json(data);
      }

      const jsStart = new Date(start);
      const jsEnd   = new Date(end);
      const totalMs = jsEnd - jsStart;

      if (!Number.isFinite(totalMs) || totalMs <= 0) {
        return res.status(400).json({ error: 'Intervalo de tempo inválido.' });
      }

      const totalSec  = Math.max(1, Math.floor(totalMs / 1000));
      const bucketSec = Math.max(1, Math.floor(totalSec / maxPoints));

      const sqlAgg = `
        SELECT
          bucketStart,
          AVG(value) AS value
        FROM (
          SELECT
            FROM_UNIXTIME(
              FLOOR(UNIX_TIMESTAMP(CONVERT_TZ(ts, @@session.time_zone, '+00:00')) / ?) * ?
            ) AS bucketStart,
            \`${metric}\` AS value
          FROM readings
          WHERE \`${metric}\` IS NOT NULL
            AND ts BETWEEN CONVERT_TZ(?, '+00:00', @@session.time_zone)
                       AND CONVERT_TZ(?, '+00:00', @@session.time_zone)
        ) AS sub
        GROUP BY bucketStart
        ORDER BY bucketStart ASC
      `;

      const params = [bucketSec, bucketSec, startUtc, endUtc];
      const [rows] = await pool.query(sqlAgg, params);

      const data = rows.map((r) => ({
        ts: new Date(r.bucketStart).toISOString(),
        [metric]: r.value !== null ? Number(r.value) : null
      }));
      return res.json(data);
    }

    const sql = `
      SELECT ts, \`${metric}\` AS value
      FROM readings
      WHERE \`${metric}\` IS NOT NULL
        AND ts BETWEEN CONVERT_TZ(?, '+00:00', @@session.time_zone)
                   AND CONVERT_TZ(?, '+00:00', @@session.time_zone)
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
  let conn;
  let query;
  let completed = false;

  const releaseConnection = () => {
    if (conn) {
      conn.release();
      conn = null;
    }
  };

  const failStream = (err) => {
    if (completed) return;
    completed = true;

    logger.error(err, 'Erro /api/download');
    releaseConnection();

    if (!res.headersSent) {
      res.status(500).json({ error: 'Erro interno ao consultar o banco para download.' });
      return;
    }

    if (!res.destroyed) {
      res.destroy(err);
    }
  };

  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: 'Parâmetros "start" e "end" são obrigatórios (ISO).' });
    }

    const startUtc = toMysqlDateTimeUTC(start);
    const endUtc = toMysqlDateTimeUTC(end);

    conn = await pool.getConnection();

    const columns = ['ts'].concat(ALL_METRICS).map((col) => `\`${col}\``).join(', ');
    
    // OTIMIZAÇÃO DOWNLOAD (Uso do Índice)
    const sql = `
      SELECT ${columns}
      FROM readings
      WHERE ts BETWEEN CONVERT_TZ(?, '+00:00', @@session.time_zone)
                   AND CONVERT_TZ(?, '+00:00', @@session.time_zone)
      ORDER BY ts ASC
    `;

    const rawConn = conn.connection;
    if (!rawConn || typeof rawConn.query !== 'function') {
      throw new Error('Conexao mysql2 sem interface de stream disponivel.');
    }

    const filename = `dados_painel_full_${start.slice(0, 10)}_a_${end.slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.flushHeaders();

    res.on('close', () => {
      if (completed) return;
      completed = true;

      if (query) {
        query.removeAllListeners();
      }

      if (typeof rawConn.destroy === 'function') {
        rawConn.destroy();
        conn = null;
      } else {
        releaseConnection();
      }
    });

    res.write(csvLine(['Instante'].concat(ALL_METRICS)));

    query = rawConn.query(sql, [startUtc, endUtc]);

    query.on('result', (row) => {
      try {
        const values = ALL_METRICS.map((metric) => {
          const value = row[metric];
          return value !== null && value !== undefined ? Number(value) : '';
        });
        const line = csvLine([formatCsvTimestamp(row.ts)].concat(values));

        if (!res.write(line) && typeof rawConn.pause === 'function') {
          rawConn.pause();
          res.once('drain', () => {
            if (!completed && typeof rawConn.resume === 'function') {
              rawConn.resume();
            }
          });
        }
      } catch (err) {
        if (typeof rawConn.destroy === 'function') {
          rawConn.destroy();
          conn = null;
        }
        failStream(err);
      }
    });

    query.on('end', () => {
      if (completed) return;
      completed = true;
      releaseConnection();
      res.end();
    });

    query.on('error', failStream);
  } catch (err) {
    failStream(err);
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
                      voltage, current_mA, power_mW, lux, temperature, humidity, irradiance, estimatedPower, falha
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

            const fmtPower = (v, suf) =>
              v === null || v === undefined ? '--' : `${(Number(v) / 1000).toFixed(3)}${suf}`;

            const lines = rows.map((r) =>
              [
                `🕒 ${r.ts}`,
                `Tensão: ${fmt(r.voltage, ' V')}`,
                `Corrente: ${fmt(r.current_mA, ' A')}`,
                `Potência: ${fmtPower(r.power_mW, ' W')}`,
                `Luminosidade: ${fmt(r.lux, ' lux')}`,
                `Temperatura: ${fmt(r.temperature, ' °C')}`,
                `Umidade: ${fmt(r.humidity, ' %')}`,
                `Irradiância: ${fmt(r.irradiance, ' W/m²')}`,
                `Pot. Estimada: ${fmt(r.estimatedPower, ' W')}`,
                `Falha: ${r.falha ? 'Ativada' : 'Desativada'}`
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

  setInterval(() => {
    try {
      publishAllIfChanged();
    } catch (err) {
      logger.error(err, 'Erro ao publicar estado agregado /all');
    }
  }, 1000);

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
