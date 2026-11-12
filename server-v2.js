// server-v2.js
// Backend: Express, MySQL, MQTT, SSE Live View e WhatsApp (Baileys)
//
// Fluxo de dados (ESP32 unificado):
//   ESP32 --painelfv/<dev>/data--> backend --INSERT IGNORE--> MySQL
//   backend --painelfv/<dev>/ack--> ESP32 (so apos COMMIT; ESP descarta o lote)
//   backend --topicos legados--> Ditto (gemeo digital), apenas dados recentes
//
// Cada registro chega com (device_id, boot_id, seq). A chave unica no banco torna
// reenvios idempotentes: duplicatas sao ignoradas e o ACK e reenviado.
// Todas as grandezas sao recebidas e gravadas em SI (V, A, W, Pa, W/m2, lx, C).

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
  DisconnectReason,
  jidNormalizedUser
} = require('baileys');

let lastQR = null;
const CONFIG_INI_PATH = path.join(__dirname, 'config.ini');

// Senhas NAO ficam aqui nem no config.ini versionado: use variaveis de ambiente
// (arquivo .env, ignorado pelo git; veja .env.example).
const defaultIniContent = `# Configurações do painel fotovoltaico e backend
# Gerado automaticamente se não existir. Senhas vêm do ambiente (.env).

[pv]
voc0 = 22.5
isc0 = 0.6
vmp0 = 19
imp0 = 0.53
alphav = -0.307
alphai = 0.039
G0 = 1000
T0 = 25
q = 1.602e-19
kConst = 1.3806503e-23
Ns = 36
loadResistance = 22
iscRef = 0.61

[app]
PORT = 4000
DB_HOST = painel-mysql
DB_PORT = 3306
DB_USER = root
DB_NAME = painelSolar
MQTT_URL = mqtt://cerise.freeddns.org:30001
MQTT_PINS_TOPIC = /painelfotovoltaico.gerador/GPIO
AUTH_DIR = /data/baileys_auth_info
LOG_LEVEL = info
GPIO_THING_ID = painelfotovoltaico.gerador:GPIO
MQTT_ESTIMATED_POWER_TOPIC = /painelfotovoltaico.referencia/estimatedPower
MQTT_PV_CONFIG_CMD_TOPIC = /painelfotovoltaico.node/pvConfig
ESTIMATED_POWER_THING_ID = painelfotovoltaico.node:estimatedPower
MQTT_ALL_TOPIC = /painelfotovoltaico.node/all
ALL_THING_ID = painelfotovoltaico.node:all
DEVICE_TOPIC_PREFIX = painelfv
DEVICE_IDS = painelfv01
DITTO_FORWARD = true
`;

if (!fs.existsSync(CONFIG_INI_PATH)) fs.writeFileSync(CONFIG_INI_PATH, defaultIniContent, 'utf8');

function parseIni(str) {
  const result = {};
  let section = null;
  for (let line of str.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1).trim();
      if (!result[section]) result[section] = {};
      continue;
    }
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).split(/\s+[;#]/, 1)[0].trim();
    if (section) result[section][key] = value;
    else result[key] = value;
  }
  return result;
}

function buildIni(obj) {
  const lines = ['# Arquivo gerado automaticamente. Edite com cuidado. Senhas ficam no .env.', ''];
  for (const [sectionName, section] of Object.entries(obj)) {
    lines.push(`[${sectionName}]`);
    for (const [key, value] of Object.entries(section)) lines.push(`${key} = ${value}`);
    lines.push('');
  }
  return lines.join('\n');
}

const iniRaw = fs.readFileSync(CONFIG_INI_PATH, 'utf8');
const iniConfig = parseIni(iniRaw);
const pvCfg = iniConfig.pv || {};
const appCfg = iniConfig.app || {};
const numOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

const {
  PORT = appCfg.PORT || '4000',
  DB_HOST = appCfg.DB_HOST || 'painel-mysql',
  DB_PORT = appCfg.DB_PORT || '3306',
  DB_USER = appCfg.DB_USER || 'root',
  DB_PASS = appCfg.DB_PASS || '',
  DB_NAME = appCfg.DB_NAME || 'painelSolar',
  MQTT_URL = appCfg.MQTT_URL || 'mqtt://cerise.freeddns.org:30001',
  MQTT_USER = appCfg.MQTT_USER || '',
  MQTT_PASS = appCfg.MQTT_PASS || '',
  MQTT_PINS_TOPIC = appCfg.MQTT_PINS_TOPIC || '/painelfotovoltaico.gerador/GPIO',
  AUTH_DIR = appCfg.AUTH_DIR || '/data/baileys_auth_info',
  LOG_LEVEL = appCfg.LOG_LEVEL || 'info'
} = process.env;

const GPIO_THING_ID = appCfg.GPIO_THING_ID || 'painelfotovoltaico.gerador:GPIO';
const MQTT_ESTIMATED_POWER_TOPIC = appCfg.MQTT_ESTIMATED_POWER_TOPIC || '/painelfotovoltaico.referencia/estimatedPower';
const ESTIMATED_POWER_THING_ID = appCfg.ESTIMATED_POWER_THING_ID || 'painelfotovoltaico.node:estimatedPower';
const MQTT_PV_CONFIG_CMD_TOPIC = appCfg.MQTT_PV_CONFIG_CMD_TOPIC || '/painelfotovoltaico.node/pvConfig';
const MQTT_ALL_TOPIC = appCfg.MQTT_ALL_TOPIC || '/painelfotovoltaico.node/all';
const ALL_THING_ID = appCfg.ALL_THING_ID || 'painelfotovoltaico.node:all';
const DEVICE_TOPIC_PREFIX = process.env.DEVICE_TOPIC_PREFIX || appCfg.DEVICE_TOPIC_PREFIX || 'painelfv';
const CONFIGURED_DEVICE_IDS = String(process.env.DEVICE_IDS || appCfg.DEVICE_IDS || 'painelfv01')
  .split(',').map((s) => s.trim()).filter(Boolean);
const DITTO_FORWARD = String(process.env.DITTO_FORWARD ?? appCfg.DITTO_FORWARD ?? 'true').toLowerCase() !== 'false';

// Alertas no WhatsApp quando o painel para de enviar dados.
const ALERT_WHATSAPP_NUMBER = String(process.env.ALERT_WHATSAPP_NUMBER || appCfg.ALERT_WHATSAPP_NUMBER || '').replace(/\D/g, '');
const ALERT_STATE_PATH = process.env.ALERT_STATE_PATH || '/data/whatsapp-alert-state.json';
// ALERT_STEPS_MIN/ALERT_DAILY_MIN/ALERT_CHECK_MS existem só para testes acelerados.
const OUTAGE_ALERT_STEPS_MIN = process.env.ALERT_STEPS_MIN ? process.env.ALERT_STEPS_MIN.split(',').map(Number) : [10, 60, 180, 360, 720];
const OUTAGE_DAILY_MIN = Number(process.env.ALERT_DAILY_MIN) || 24 * 60;  // depois, a cada 24 h
const ALERT_CHECK_MS = Number(process.env.ALERT_CHECK_MS) || 30000;
const ALERT_TZ = 'America/Sao_Paulo';

// Timeouts: nenhuma consulta pode prender o pool indefinidamente.
const DB_QUERY_TIMEOUT_MS = 60000;
const DB_INSERT_TIMEOUT_MS = 30000;
const CSV_QUERY_TIMEOUT_MS = 15 * 60 * 1000;
const HEALTH_DB_TIMEOUT_MS = 3000;
const MQTT_UNHEALTHY_AFTER_MS = 5 * 60 * 1000;

const DEVICE_ID_RE = /^[a-z0-9_-]{1,32}$/;
const LIVE_TTL_S = 60;              // ESP volta ao modo normal se o backend sumir
const LIVE_REFRESH_MS = 20000;
const FRESH_WINDOW_MS = 120000;     // so registros recentes vao para Live View/Ditto
const MIN_VALID_TS = Date.UTC(2025, 0, 1) / 1000;

if (!DB_PASS) console.warn('[config] DB_PASS vazio: defina no .env.');
if (!MQTT_PASS) console.warn('[config] MQTT_PASS vazio: defina no .env.');

// Ditto: apenas o evento de configuração PV continua chegando por lá.
const MQTT_TOPICS = [
  `${DEVICE_TOPIC_PREFIX}/+/data`,
  `${DEVICE_TOPIC_PREFIX}/+/status`,
  '/ditto/events/painelfotovoltaico.node/pvConfig'
];

// Tópicos legados que alimentam o gêmeo digital no Ditto (antes publicados pelos ESP32).
const DITTO_TARGETS = {
  INA226: { topic: '/painelfotovoltaico.gerador/INA226', thingId: 'painelfotovoltaico.gerador:INA226' },
  TSL2591: { topic: '/painelfotovoltaico.gerador/TSL2591', thingId: 'painelfotovoltaico.gerador:TSL2591' },
  AHT20: { topic: '/painelfotovoltaico.gerador/AHT20', thingId: 'painelfotovoltaico.gerador:AHT20' },
  BMP280: { topic: '/painelfotovoltaico.gerador/BMP280', thingId: 'painelfotovoltaico.gerador:BMP280' },
  GPIO: { topic: MQTT_PINS_TOPIC, thingId: GPIO_THING_ID },
  PainelParametros: { topic: '/painelfotovoltaico.gerador/PainelParametros', thingId: 'painelfotovoltaico.gerador:PainelParametros' },
  REFERENCIA: { topic: '/painelfotovoltaico.referencia/esp32', thingId: 'painelfotovoltaico.referencia:esp32' }
};

const logger = P({ level: LOG_LEVEL });
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let falhaState = 0;
let lastGeneratorReceivedAt = null;
let lastReferenceReceivedAt = null;

const state = {
  voltage: null,
  current_A: null,
  power_W: null,
  current_ref_A: null,
  lux: null,
  temperature: null,
  humidity: null,
  pressure_Pa: null,
  irradiance: null,
  estimatedPower: null,
  expectedLoadVoltage: null,
  expectedLoadCurrent: null,
  estimatedVmp: null,
  estimatedImp: null,
  estimatedMppPower: null
};

let voc0 = numOr(pvCfg.voc0, 22.5);
let isc0 = numOr(pvCfg.isc0, 0.6);
let vmp0 = numOr(pvCfg.vmp0, 19);
let imp0 = numOr(pvCfg.imp0, 0.53);
let alphav = numOr(pvCfg.alphav, -0.307) / 100;
let alphai = numOr(pvCfg.alphai, 0.039) / 100;
let G0 = numOr(pvCfg.G0, 1000);
let T0 = numOr(pvCfg.T0, 25);
let q = numOr(pvCfg.q, 1.602e-19);
let kConst = numOr(pvCfg.kConst, 1.3806503e-23);
let Ns = numOr(pvCfg.Ns, 36);
let loadResistance = numOr(pvCfg.loadResistance, 22);
let iscRef = numOr(pvCfg.iscRef, 0.61);
let kv = vmp0 / voc0;
let ki = imp0 / isc0;

let pool;

// ===========================================================================
// Banco de dados
// ===========================================================================
// Consulta com timeout: se estourar, o mysql2 destrói a conexão e a devolve ao pool.
function dbQuery(sql, params = [], timeout = DB_QUERY_TIMEOUT_MS) {
  return pool.query({ sql, timeout }, params);
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: timeout ${ms} ms`)), ms); })
  ]).finally(() => clearTimeout(timer));
}

async function ensureColumn(name, definition) {
  try { await pool.query(`ALTER TABLE readings ADD COLUMN \`${name}\` ${definition}`); }
  catch (err) { if (err.code !== 'ER_DUP_FIELDNAME') throw err; }
}

async function ensureIndex(name, expression, unique = false) {
  try { await pool.query(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX \`${name}\` ON readings (${expression})`); }
  catch (err) { if (err.code !== 'ER_DUP_KEYNAME') throw err; }
}

async function columnExists(name) {
  const [rows] = await pool.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['readings', name]
  );
  return rows.length > 0;
}

// Renomeia colunas com unidade errada no nome (os valores já eram gravados em A e W).
async function renameColumn(from, to, definition) {
  if (await columnExists(from) && !(await columnExists(to))) {
    await pool.query(`ALTER TABLE readings CHANGE COLUMN \`${from}\` \`${to}\` ${definition}`);
    logger.info({ from, to }, 'Coluna renomeada para unidade SI.');
  }
}

async function initDb() {
  pool = await mysql.createPool({
    host: DB_HOST,
    port: Number(DB_PORT),
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    connectionLimit: 10,
    waitForConnections: true,
    queueLimit: 100,          // fila limitada: erro rápido em vez de espera infinita
    connectTimeout: 10000,
    enableKeepAlive: true,
    supportBigNumbers: true,
    dateStrings: true
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS readings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      voltage DOUBLE NULL,
      current_A DOUBLE NULL,
      power_W DOUBLE NULL,
      lux DOUBLE NULL,
      temperature DOUBLE NULL,
      humidity DOUBLE NULL,
      irradiance DOUBLE NULL,
      estimatedPower DOUBLE NULL,
      falha TINYINT(1) DEFAULT 0,
      INDEX idx_ts (ts)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await renameColumn('current_mA', 'current_A', 'DOUBLE NULL');
  await renameColumn('power_mW', 'power_W', 'DOUBLE NULL');

  await ensureColumn('falha', 'TINYINT(1) DEFAULT 0');
  await ensureColumn('heartbeat_ts', 'DATETIME(3) NULL');
  await ensureColumn('generator_last_received_ts', 'DATETIME(3) NULL');
  await ensureColumn('reference_last_received_ts', 'DATETIME(3) NULL');
  await ensureColumn('expectedLoadVoltage', 'DOUBLE NULL');
  await ensureColumn('expectedLoadCurrent', 'DOUBLE NULL');
  await ensureColumn('estimatedVmp', 'DOUBLE NULL');
  await ensureColumn('estimatedImp', 'DOUBLE NULL');
  await ensureColumn('estimatedMppPower', 'DOUBLE NULL');
  // ESP32 unificado
  await ensureColumn('device_id', 'VARCHAR(32) NULL');
  await ensureColumn('boot_id', 'SMALLINT UNSIGNED NULL');
  await ensureColumn('seq', 'INT UNSIGNED NULL');
  await ensureColumn('samples', 'SMALLINT UNSIGNED NULL');
  await ensureColumn('received_at', 'DATETIME(3) NULL');
  await ensureColumn('current_ref_A', 'DOUBLE NULL');
  await ensureColumn('visible', 'INT NULL');
  await ensureColumn('infrared', 'INT NULL');
  await ensureColumn('temperature_bmp', 'DOUBLE NULL');
  await ensureColumn('pressure_Pa', 'DOUBLE NULL');
  await ensureColumn('gpio23', 'TINYINT(1) NULL');
  await ensureColumn('time_estimated', 'TINYINT(1) NULL');
  await ensureIndex('idx_heartbeat_ts', '`heartbeat_ts`');
  // Deduplicação: um registro do ESP32 nunca entra duas vezes.
  await ensureIndex('uq_readings_device_boot_seq', '`device_id`, `boot_id`, `seq`', true);

  try {
    const [rows] = await pool.query('SELECT falha FROM readings ORDER BY ts DESC LIMIT 1');
    if (rows.length) falhaState = rows[0].falha || 0;
  } catch (err) {
    logger.error(err, 'Erro ao carregar estado inicial de falha');
  }

  logger.info('🗄️ Tabela readings pronta (1 linha por registro do ESP32, chave única de deduplicação).');
}

// ===========================================================================
// Modelo FV
// ===========================================================================
function buildPvModel(G, T) {
  if (!Number.isFinite(G) || !Number.isFinite(T) || G <= 0 || loadResistance <= 0) {
    return { voc: 0, isc: 0, vmp: 0, imp: 0, a: 0, b: 0, c: 0, d: 0, eParam: 0, f: 0, valid: G === 0 && Number.isFinite(T) };
  }
  const Vt = (kConst * (T + 273.15)) / q;
  const voc = Ns * Vt * Math.log(G / G0 + 1e-9) + voc0 * (1 + alphav * (T - T0));
  const isc = isc0 * (G / G0) * (1 + alphai * (T - T0));
  const imp = isc * ki;
  const vmp = voc * kv;
  const denomVocVmp2 = Math.pow(voc - vmp, 2);
  const denomImpIsc2 = Math.pow(imp - isc, 2);
  if (![voc, isc, imp, vmp, denomVocVmp2, denomImpIsc2].every(Number.isFinite) || voc <= 0 || isc <= 0 || imp <= 0 || vmp <= 0 || denomVocVmp2 <= 1e-12 || denomImpIsc2 <= 1e-12) return { valid: false, voc, isc, vmp, imp };
  const a = (imp / denomVocVmp2) * (voc / vmp - 2);
  const b = (-2 * vmp * imp / denomVocVmp2) * (voc / vmp - 2) - imp / vmp;
  const c = (imp * voc) / vmp - (voc * imp * Math.pow(voc - 2 * vmp, 2)) / (vmp * denomVocVmp2);
  const d = (-vmp * (2 * imp - isc)) / (imp * denomImpIsc2);
  const eParam = (2 * vmp * (2 * imp - isc)) / denomImpIsc2 - vmp / imp;
  const f = (vmp * isc * (2 * isc - 3 * imp)) / denomImpIsc2;
  const valid = [a, b, c, d, eParam, f].every(Number.isFinite) && Math.abs(d) > 1e-12;
  return { valid, voc, isc, vmp, imp, a, b, c, d, eParam, f };
}

function currentAtVoltage(V, model) {
  if (!model || !model.valid || !Number.isFinite(V)) return null;
  if (model.voc <= 0 || model.isc <= 0) return 0;
  let current;
  if (V >= model.vmp) current = model.a * V * V + model.b * V + model.c;
  else {
    const disc = Math.max(model.eParam * model.eParam - 4 * model.d * (model.f - V), 0);
    current = (-model.eParam - Math.sqrt(disc)) / (2 * model.d);
  }
  if (!Number.isFinite(current)) return null;
  return Math.max(0, Math.min(model.isc * 1.25, current));
}

function solveResistiveLoadPoint(model, resistanceOhm) {
  if (!model || !model.valid || !Number.isFinite(resistanceOhm) || resistanceOhm <= 0) return null;
  if (model.voc <= 0 || model.isc <= 0) return { voltage: 0, current: 0, power: 0 };
  const fn = (V) => {
    const ipv = currentAtVoltage(V, model);
    return ipv === null ? NaN : ipv - V / resistanceOhm;
  };
  let lo = 0, hi = model.voc, flo = fn(lo), fhi = fn(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi)) return null;
  if (flo * fhi > 0) {
    let prevV = lo, prevF = flo, found = false;
    for (let n = 1; n <= 200; n++) {
      const V = model.voc * n / 200, fv = fn(V);
      if (Number.isFinite(fv) && prevF * fv <= 0) {
        lo = prevV; hi = V; flo = prevF; fhi = fv; found = true; break;
      }
      prevV = V; prevF = fv;
    }
    if (!found) return null;
  }
  for (let n = 0; n < 64; n++) {
    const mid = (lo + hi) / 2, fm = fn(mid);
    if (!Number.isFinite(fm)) return null;
    if (Math.abs(fm) < 1e-9) { lo = hi = mid; break; }
    if (flo * fm <= 0) { hi = mid; fhi = fm; }
    else { lo = mid; flo = fm; }
  }
  const voltage = (lo + hi) / 2;
  const current = voltage / resistanceOhm;
  const power = voltage * current;
  return [voltage, current, power].every(Number.isFinite) ? { voltage, current, power } : null;
}

const NULL_ESTIMATES = {
  estimatedPower: null, expectedLoadVoltage: null, expectedLoadCurrent: null,
  estimatedVmp: null, estimatedImp: null, estimatedMppPower: null
};

// Estimativas para um par (irradiância, temperatura) de um registro específico.
function estimateFor(G, T) {
  if (G == null || T == null) return { ...NULL_ESTIMATES };
  if (G <= 0) {
    return { estimatedPower: 0, expectedLoadVoltage: 0, expectedLoadCurrent: 0, estimatedVmp: 0, estimatedImp: 0, estimatedMppPower: 0 };
  }
  const model = buildPvModel(G, T);
  if (!model.valid) return { ...NULL_ESTIMATES };
  const loadPoint = solveResistiveLoadPoint(model, loadResistance);
  if (!loadPoint) return { ...NULL_ESTIMATES };
  return {
    estimatedPower: loadPoint.power,
    expectedLoadVoltage: loadPoint.voltage,
    expectedLoadCurrent: loadPoint.current,
    estimatedVmp: model.vmp,
    estimatedImp: model.imp,
    estimatedMppPower: model.vmp * model.imp
  };
}

function recalcStateEstimates() {
  Object.assign(state, estimateFor(state.irradiance, state.temperature));
}

// ===========================================================================
// Live View (SSE)
// ===========================================================================
const liveClients = new Set();
const recentHeartbeatCache = [];
const LIVE_CACHE_MS = 60 * 60 * 1000;

function isoOrNull(value) { return value instanceof Date ? value.toISOString() : (value ? new Date(value).toISOString() : null); }

function publicSnapshot(snapshot) {
  return {
    ts: snapshot.heartbeat_ts.toISOString(),
    heartbeat_ts: snapshot.heartbeat_ts.toISOString(),
    generator_last_received_ts: isoOrNull(snapshot.generator_last_received_ts),
    reference_last_received_ts: isoOrNull(snapshot.reference_last_received_ts),
    voltage: snapshot.voltage,
    current_A: snapshot.current_A,
    power_W: snapshot.power_W,
    current_ref_A: snapshot.current_ref_A,
    lux: snapshot.lux,
    temperature: snapshot.temperature,
    humidity: snapshot.humidity,
    pressure_Pa: snapshot.pressure_Pa,
    irradiance: snapshot.irradiance,
    estimatedPower: snapshot.estimatedPower,
    expectedLoadVoltage: snapshot.expectedLoadVoltage,
    expectedLoadCurrent: snapshot.expectedLoadCurrent,
    estimatedVmp: snapshot.estimatedVmp,
    estimatedImp: snapshot.estimatedImp,
    estimatedMppPower: snapshot.estimatedMppPower,
    falha: snapshot.falha
  };
}

function rememberHeartbeat(snapshot) {
  const entry = publicSnapshot(snapshot);
  recentHeartbeatCache.push(entry);
  const cutoff = Date.now() - LIVE_CACHE_MS;
  while (recentHeartbeatCache.length && new Date(recentHeartbeatCache[0].heartbeat_ts).getTime() < cutoff) recentHeartbeatCache.shift();
  return entry;
}

function broadcastHeartbeat(entry) {
  const payload = `id: ${Date.parse(entry.heartbeat_ts)}\nevent: heartbeat\ndata: ${JSON.stringify(entry)}\n\n`;
  for (const client of liveClients) {
    try { client.write(payload); }
    catch { liveClients.delete(client); }
  }
}

app.get('/api/live', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, serverTime: new Date().toISOString() })}\n\n`);
  const wasIdle = liveClients.size === 0;
  liveClients.add(res);
  if (wasIdle) sendLiveCommand(LIVE_TTL_S);  // pede ao ESP32 envio a cada 1 s
  const keepAlive = setInterval(() => { if (!res.destroyed) res.write(`: keepalive ${Date.now()}\n\n`); }, 15000);
  req.on('close', () => {
    clearInterval(keepAlive);
    liveClients.delete(res);
    if (liveClients.size === 0) sendLiveCommand(0);  // volta ao modo econômico
  });
});

app.get('/api/live-cache', (req, res) => {
  try {
    const since = req.query.since ? new Date(String(req.query.since)).getTime() : Date.now() - 60000;
    if (!Number.isFinite(since)) return res.status(400).json({ error: 'since inválido' });
    res.json(recentHeartbeatCache.filter((r) => Date.parse(r.heartbeat_ts) > since));
  } catch (err) {
    logger.error(err, 'Erro /api/live-cache');
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ===========================================================================
// MQTT
// ===========================================================================
let mqttClient;
const knownDevices = new Set(CONFIGURED_DEVICE_IDS);
const deviceStatus = new Map();
const lastLiveTsByDevice = new Map();
const deviceQueues = new Map();

const deviceTopic = (deviceId, kind) => `${DEVICE_TOPIC_PREFIX}/${deviceId}/${kind}`;

function publishJson(topic, obj, opts = { qos: 0 }) {
  if (!mqttClient || !mqttClient.connected) return;
  mqttClient.publish(topic, JSON.stringify(obj), opts, (err) => {
    if (err) logger.error({ err, topic }, 'Erro ao publicar MQTT');
  });
}

function sendDeviceCommand(cmd, deviceId = null) {
  const targets = deviceId ? [deviceId] : [...knownDevices];
  for (const dev of targets) publishJson(deviceTopic(dev, 'cmd'), cmd, { qos: 1 });
}

function sendLiveCommand(ttl) {
  sendDeviceCommand({ live: ttl });
  logger.info({ ttl, devices: [...knownDevices] }, ttl ? 'Live View ativo: ESP32 em modo 1 s' : 'Live View inativo: ESP32 em modo econômico');
}
setInterval(() => { if (liveClients.size > 0) sendLiveCommand(LIVE_TTL_S); }, LIVE_REFRESH_MS);

function publishAll() {
  publishJson(MQTT_ALL_TOPIC, {
    thingId: ALL_THING_ID,
    sensorData: {
      voltage: state.voltage,
      current_A: state.current_A,
      power_W: state.power_W,
      current_ref_A: state.current_ref_A,
      lux: state.lux,
      temperature: state.temperature,
      humidity: state.humidity,
      pressure_Pa: state.pressure_Pa,
      irradiance: state.irradiance,
      estimatedPower: state.estimatedPower,
      expectedLoadVoltage: state.expectedLoadVoltage,
      expectedLoadCurrent: state.expectedLoadCurrent,
      estimatedVmp: state.estimatedVmp,
      estimatedImp: state.estimatedImp,
      estimatedMppPower: state.estimatedMppPower,
      generator_last_received_ts: isoOrNull(lastGeneratorReceivedAt),
      reference_last_received_ts: isoOrNull(lastReferenceReceivedAt)
    }
  });
}

function publishEstimates() {
  if (state.estimatedPower == null) return;
  const fix = (v, d) => (v == null ? null : Number(v.toFixed(d)));
  publishJson(MQTT_ESTIMATED_POWER_TOPIC, {
    thingId: ESTIMATED_POWER_THING_ID,
    sensorData: {
      estimatedPower: fix(state.estimatedPower, 3),
      expectedLoadVoltage: fix(state.expectedLoadVoltage, 4),
      expectedLoadCurrent: fix(state.expectedLoadCurrent, 6),
      estimatedVmp: fix(state.estimatedVmp, 4),
      estimatedImp: fix(state.estimatedImp, 6),
      estimatedMppPower: fix(state.estimatedMppPower, 3),
      loadResistance
    }
  }, { qos: 1 });
}

function forwardToDitto(row) {
  if (!DITTO_FORWARD) return;
  const send = (target, sensorData) => publishJson(target.topic, { thingId: target.thingId, sensorData });
  if (row.voltage != null) send(DITTO_TARGETS.INA226, { voltage: row.voltage, current: row.current_A, power: row.power_W, samples: row.samples });
  if (row.lux != null) send(DITTO_TARGETS.TSL2591, { lux: row.lux, visible: row.visible, infrared: row.infrared });
  if (row.temperature != null) send(DITTO_TARGETS.AHT20, { temperature: row.temperature, humidity: row.humidity });
  if (row.temperature_bmp != null) send(DITTO_TARGETS.BMP280, { temperature: row.temperature_bmp, pressure: row.pressure_Pa });
  if (row.gpio23 != null) send(DITTO_TARGETS.GPIO, { GPIO23: row.gpio23 });
  if (row.irradiance != null) send(DITTO_TARGETS.REFERENCIA, { irradiance: row.irradiance, current: row.current_ref_A });
}

// Layout de cada registro enviado pelo ESP32 (ver firmware net.cpp):
// [boot, seq, ts, n, flags, V, I, P, Iref, G, lux, vis, ir, T, RH, Tb, Pa]
const FLAG_GPIO23 = 1 << 5;
const FLAG_TIME_EST = 1 << 6;
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const intOrNull = (v) => (Number.isInteger(v) ? v : null);

function parseRecord(deviceId, r, receivedAt) {
  if (!Array.isArray(r) || r.length < 17) return null;
  const [boot, seq, ts, n, flags] = r;
  if (![boot, seq, ts, n, flags].every(Number.isInteger)) return null;
  const nowS = receivedAt.getTime() / 1000;
  if (ts < MIN_VALID_TS || ts > nowS + 86400) return null;
  const tsDate = new Date(ts * 1000);
  const row = {
    device_id: deviceId,
    boot_id: boot,
    seq,
    samples: n,
    ts: tsDate,
    received_at: receivedAt,
    voltage: numOrNull(r[5]),
    current_A: numOrNull(r[6]),
    power_W: numOrNull(r[7]),
    current_ref_A: numOrNull(r[8]),
    irradiance: numOrNull(r[9]),
    lux: numOrNull(r[10]),
    visible: intOrNull(r[11]),
    infrared: intOrNull(r[12]),
    temperature: numOrNull(r[13]),
    humidity: numOrNull(r[14]),
    temperature_bmp: numOrNull(r[15]),
    pressure_Pa: numOrNull(r[16]),
    gpio23: flags & FLAG_GPIO23 ? 1 : 0,
    time_estimated: flags & FLAG_TIME_EST ? 1 : 0
  };
  Object.assign(row, estimateFor(row.irradiance, row.temperature));
  return row;
}

const INSERT_COLUMNS = [
  'device_id', 'boot_id', 'seq', 'samples', 'ts', 'heartbeat_ts', 'generator_last_received_ts',
  'reference_last_received_ts', 'received_at', 'voltage', 'current_A', 'power_W', 'current_ref_A',
  'irradiance', 'lux', 'visible', 'infrared', 'temperature', 'humidity', 'temperature_bmp', 'pressure_Pa',
  'gpio23', 'time_estimated', 'estimatedPower', 'expectedLoadVoltage', 'expectedLoadCurrent',
  'estimatedVmp', 'estimatedImp', 'estimatedMppPower', 'falha'
];

function rowValues(row) {
  // ts de origem também nos campos legados de timestamp, para o Live View/consultas antigas.
  return INSERT_COLUMNS.map((c) => {
    if (c === 'heartbeat_ts' || c === 'generator_last_received_ts' || c === 'reference_last_received_ts') return row.ts;
    if (c === 'falha') return falhaState;  // o trigger corrige pelo histórico de fault_intervals
    return row[c] ?? null;
  });
}

function applyFreshRows(deviceId, rows) {
  const lastTs = lastLiveTsByDevice.get(deviceId) || 0;
  const cutoff = Date.now() - FRESH_WINDOW_MS;
  const fresh = rows
    .filter((r) => r.ts.getTime() > lastTs && r.ts.getTime() >= cutoff)
    .sort((a, b) => a.ts - b.ts);
  if (!fresh.length) return;
  lastLiveTsByDevice.set(deviceId, fresh[fresh.length - 1].ts.getTime());

  for (const row of fresh) {
    for (const key of Object.keys(state)) if (row[key] !== undefined && row[key] !== null) state[key] = row[key];
    if (row.voltage != null) lastGeneratorReceivedAt = row.ts;
    if (row.irradiance != null) lastReferenceReceivedAt = row.ts;
    const snapshot = {
      ...row,
      heartbeat_ts: row.ts,
      generator_last_received_ts: row.ts,
      reference_last_received_ts: row.ts,
      falha: falhaState
    };
    broadcastHeartbeat(rememberHeartbeat(snapshot));
  }

  // Gêmeo digital e tópicos agregados: só o estado mais recente.
  forwardToDitto(fresh[fresh.length - 1]);
  publishEstimates();
  publishAll();
}

async function handleDataBatch(deviceId, payloadBuf) {
  const receivedAt = new Date();
  let msg;
  const raw = payloadBuf.toString('utf8');
  try { msg = JSON.parse(raw); }
  catch {
    // FW <= 3.0.1 escrevia lux NaN como "nan" (JSON invalido). Trata como null.
    const fixed = raw.replace(/([\[,])\s*-?(?:nan|inf(?:inity)?)\s*(?=[,\]])/gi, '$1null');
    try { msg = JSON.parse(fixed); logger.info({ deviceId }, 'Lote com NaN/Inf convertido para null'); }
    catch { logger.warn({ deviceId }, 'Lote com JSON inválido'); return; }
  }
  const id = msg && Number.isInteger(msg.id) ? msg.id : null;
  if (id === null || !Array.isArray(msg.r)) { logger.warn({ deviceId }, 'Lote sem id/registros'); return; }
  markDataReceived(deviceId, receivedAt);

  const rows = [];
  let rejected = 0;
  for (const r of msg.r) {
    const row = parseRecord(deviceId, r, receivedAt);
    if (row) rows.push(row); else rejected += 1;
  }

  const ackTopic = deviceTopic(deviceId, 'ack');
  try {
    let inserted = 0;
    if (rows.length) {
      const [result] = await dbQuery(
        `INSERT IGNORE INTO readings (${INSERT_COLUMNS.map((c) => `\`${c}\``).join(', ')}) VALUES ?`,
        [rows.map(rowValues)],
        DB_INSERT_TIMEOUT_MS
      );
      inserted = result.affectedRows || 0;
    }
    // ACK apenas depois do COMMIT (autocommit do INSERT). Duplicatas também são confirmadas.
    publishJson(ackTopic, { id, ok: true, inserted, duplicates: rows.length - inserted, rejected }, { qos: 1 });
    logger.debug({ deviceId, id, inserted, duplicates: rows.length - inserted, rejected }, 'Lote gravado');
  } catch (err) {
    logger.error({ err, deviceId, id }, 'Erro ao gravar lote; ESP32 vai reenviar.');
    publishJson(ackTopic, { id, ok: false, error: 'db' }, { qos: 1 });
    return;
  }

  try { applyFreshRows(deviceId, rows); }
  catch (err) { logger.error({ err }, 'Erro ao atualizar Live View/Ditto'); }
}

function handleDeviceStatus(deviceId, payloadBuf) {
  let status;
  try { status = JSON.parse(payloadBuf.toString('utf8')); }
  catch { return; }
  const previous = deviceStatus.get(deviceId);
  deviceStatus.set(deviceId, { ...status, received_at: new Date().toISOString() });
  logger.info({ deviceId, online: status.online, pending: status.buffer?.pending, fw: status.fw }, 'Status do ESP32');
  if (status.online && liveClients.size > 0) sendLiveCommand(LIVE_TTL_S);
  if (status.params) {
    if (Number.isFinite(status.params.iscRef)) iscRef = status.params.iscRef;
    if (DITTO_FORWARD && JSON.stringify(previous?.params) !== JSON.stringify(status.params)) {
      const { interval, ...panel } = status.params;
      publishJson(DITTO_TARGETS.PainelParametros.topic, { thingId: DITTO_TARGETS.PainelParametros.thingId, sensorData: panel });
    }
  }
}

function enqueueForDevice(deviceId, task) {
  const prev = deviceQueues.get(deviceId) || Promise.resolve();
  const next = prev.then(task).catch((err) => logger.error({ err, deviceId }, 'Erro na fila do dispositivo'));
  deviceQueues.set(deviceId, next);
}

const PV_FIELDS = ['voc0', 'isc0', 'vmp0', 'imp0', 'alphav', 'alphai', 'G0', 'T0', 'q', 'kConst', 'Ns', 'loadResistance'];

function applyPvConfig(sensorData) {
  const updated = {};
  for (const key of PV_FIELDS) {
    if (sensorData[key] === undefined) continue;
    const n = Number(sensorData[key]);
    if (!Number.isFinite(n)) throw new Error(`Valor inválido para ${key}: ${sensorData[key]}`);
    updated[key] = n;
  }
  if (!Object.keys(updated).length) throw new Error('Nenhum campo PV recebido.');
  if (updated.voc0 !== undefined) voc0 = updated.voc0;
  if (updated.isc0 !== undefined) isc0 = updated.isc0;
  if (updated.vmp0 !== undefined) vmp0 = updated.vmp0;
  if (updated.imp0 !== undefined) imp0 = updated.imp0;
  if (updated.alphav !== undefined) alphav = updated.alphav / 100;
  if (updated.alphai !== undefined) alphai = updated.alphai / 100;
  if (updated.G0 !== undefined) G0 = updated.G0;
  if (updated.T0 !== undefined) T0 = updated.T0;
  if (updated.q !== undefined) q = updated.q;
  if (updated.kConst !== undefined) kConst = updated.kConst;
  if (updated.Ns !== undefined) Ns = updated.Ns;
  if (updated.loadResistance !== undefined) loadResistance = updated.loadResistance;
  if (voc0 <= 0 || isc0 <= 0 || vmp0 <= 0 || imp0 <= 0 || G0 <= 0 || q <= 0 || kConst <= 0 || Ns <= 0 || loadResistance <= 0) throw new Error('Parâmetros PV inválidos.');
  kv = vmp0 / voc0;
  ki = imp0 / isc0;
  iniConfig.pv = iniConfig.pv || {};
  for (const key of PV_FIELDS) if (updated[key] !== undefined) iniConfig.pv[key] = String(updated[key]);
  fs.writeFileSync(CONFIG_INI_PATH, buildIni(iniConfig), 'utf8');
  recalcStateEstimates();
  return updated;
}

// Corrente de curto da célula de referência em G0 (A). Fica salva no ESP32 (NVS);
// o backend guarda uma cópia no config.ini e a reenvia ao dispositivo.
function setIscRef(value, { send = true } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 50) throw new Error('iscRef inválido (A).');
  iscRef = n;
  iniConfig.pv = iniConfig.pv || {};
  iniConfig.pv.iscRef = String(n);
  fs.writeFileSync(CONFIG_INI_PATH, buildIni(iniConfig), 'utf8');
  if (send) sendDeviceCommand({ iscRef: n });
  return n;
}

let mqttDisconnectedSince = Date.now();

function initMqtt() {
  mqttClient = mqtt.connect(MQTT_URL, {
    username: MQTT_USER,
    password: MQTT_PASS,
    clientId: `painel-backend-${Math.random().toString(16).slice(2, 10)}`,
    reconnectPeriod: 3000
  });
  mqttClient.on('close', () => { if (!mqttDisconnectedSince) mqttDisconnectedSince = Date.now(); });
  mqttClient.on('connect', () => {
    mqttDisconnectedSince = null;
    logger.info({ MQTT_URL, MQTT_USER }, '📡 MQTT conectado');
    mqttClient.subscribe(MQTT_TOPICS, { qos: 1 }, (err) => err ? logger.error(err, 'Erro subscribe') : logger.info({ topics: MQTT_TOPICS }, 'Tópicos assinados'));
    if (liveClients.size > 0) sendLiveCommand(LIVE_TTL_S);
  });
  mqttClient.on('error', (err) => logger.error({ err }, 'Erro MQTT'));
  mqttClient.on('message', (topic, payloadBuf) => {
    const parts = topic.split('/');
    if (parts.length === 3 && parts[0] === DEVICE_TOPIC_PREFIX) {
      const [, deviceId, kind] = parts;
      if (!DEVICE_ID_RE.test(deviceId)) return;
      knownDevices.add(deviceId);
      if (kind === 'data') enqueueForDevice(deviceId, () => handleDataBatch(deviceId, payloadBuf));
      else if (kind === 'status') handleDeviceStatus(deviceId, payloadBuf);
      return;
    }
    if (topic.toLowerCase() === '/ditto/events/painelfotovoltaico.node/pvconfig') {
      let data;
      try { data = JSON.parse(payloadBuf.toString('utf8').trim()); } catch { return; }
      const sensorData = data?.sensorData;
      if (!sensorData || typeof sensorData !== 'object') return;
      try {
        if (sensorData.iscRef !== undefined && Number(sensorData.iscRef) !== iscRef) setIscRef(sensorData.iscRef);
        if (PV_FIELDS.some((k) => sensorData[k] !== undefined)) logger.info({ updated: applyPvConfig(sensorData) }, 'PV config atualizada');
      } catch (err) { logger.error({ err }, 'Erro ao processar pvConfig'); }
    }
  });
}

// ===========================================================================
// API
// ===========================================================================
app.get('/api/pv-config', (req, res) => res.json({
  voc0, isc0, vmp0, imp0, alphav: alphav * 100, alphai: alphai * 100,
  G0, T0, q, kConst, Ns, loadResistance, iscRef
}));

app.post('/api/pv-config', (req, res) => {
  const sensorData = {};
  try {
    for (const key of PV_FIELDS) {
      if (req.body?.[key] === undefined) continue;
      const n = Number(req.body[key]);
      if (!Number.isFinite(n)) return res.status(400).json({ error: `Valor inválido para ${key}.` });
      sensorData[key] = n;
    }
    const hasIscRef = req.body?.iscRef !== undefined && req.body.iscRef !== '';
    if (!Object.keys(sensorData).length && !hasIscRef) return res.status(400).json({ error: 'Nenhum parâmetro fornecido.' });
    const updated = Object.keys(sensorData).length ? applyPvConfig(sensorData) : {};
    if (hasIscRef) updated.iscRef = setIscRef(req.body.iscRef);
    if (Object.keys(sensorData).length) {
      publishJson(MQTT_PV_CONFIG_CMD_TOPIC, { thingId: 'painelfotovoltaico.node:pvConfig', sensorData }, { qos: 1 });
    }
    res.json({ ok: true, updated });
  } catch (err) {
    logger.error(err, 'Erro pv-config');
    res.status(400).json({ error: err.message || 'Erro PV config' });
  }
});

// Estado e configuração dos ESP32 (buffer, sensores, parâmetros).
app.get('/api/device-status', (req, res) => {
  res.json(Object.fromEntries([...knownDevices].map((d) => [d, deviceStatus.get(d) || null])));
});

app.post('/api/device-config', (req, res) => {
  const device = req.body?.device ? String(req.body.device) : null;
  if (device && !DEVICE_ID_RE.test(device)) return res.status(400).json({ error: 'device inválido' });
  const cmd = {};
  if (req.body?.iscRef !== undefined) {
    try { cmd.iscRef = setIscRef(req.body.iscRef, { send: false }); }
    catch (err) { return res.status(400).json({ error: err.message }); }
  }
  const interval = Number(req.body?.interval);
  if (req.body?.interval !== undefined) {
    if (!Number.isInteger(interval) || interval < 1 || interval > 600) return res.status(400).json({ error: 'interval deve estar entre 1 e 600 s' });
    cmd.interval = interval;
  }
  if (req.body?.panelParams && typeof req.body.panelParams === 'object') cmd.panelParams = req.body.panelParams;
  if (req.body?.status === true) cmd.status = true;
  if (!Object.keys(cmd).length) return res.status(400).json({ error: 'Nada para enviar.' });
  sendDeviceCommand(cmd, device);
  res.json({ ok: true, sent: cmd });
});

// Saúde do backend, usada pelo healthcheck do Docker. Só reporta falhas que um
// reinício do backend resolve (banco inacessível/pool travado, MQTT caído).
// A ausência de dados do ESP32 é informativa e NÃO derruba o health.
app.get('/api/health', async (req, res) => {
  const out = { ok: true, uptime_s: Math.round(process.uptime()), checks: {} };
  try {
    await withTimeout(dbQuery('SELECT 1', [], HEALTH_DB_TIMEOUT_MS), HEALTH_DB_TIMEOUT_MS, 'db');
    out.checks.db = 'ok';
  } catch (err) {
    out.ok = false;
    out.checks.db = String(err.message || err);
  }
  const mqttOk = !!(mqttClient && mqttClient.connected);
  out.checks.mqtt = mqttOk ? 'ok' : `desconectado há ${Math.round((Date.now() - (mqttDisconnectedSince || Date.now())) / 1000)} s`;
  if (!mqttOk && mqttDisconnectedSince && Date.now() - mqttDisconnectedSince > MQTT_UNHEALTHY_AFTER_MS) out.ok = false;
  out.checks.whatsapp = waConnected ? 'ok' : (lastQR ? 'aguardando QR' : 'desconectado');
  out.alerts_pending = pendingAlerts.length;
  out.last_data_age_s = alertState.lastDataAt ? Math.round((Date.now() - alertState.lastDataAt) / 1000) : null;
  res.status(out.ok ? 200 : 503).json(out);
});

app.get('/api/falha', async (req, res) => {
  try {
    const [rows] = await dbQuery('SELECT falha FROM readings ORDER BY ts DESC LIMIT 1');
    res.json({ falha: rows.length ? (rows[0].falha || 0) : falhaState });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar falha' }); }
});
app.post('/api/falha', (req, res) => { falhaState = req.body?.falha ? 1 : 0; res.json({ ok: true, falha: falhaState }); });

const ALLOWED_METRICS = new Set([
  'voltage', 'current_A', 'power_W', 'current_ref_A', 'lux', 'visible', 'infrared', 'temperature', 'humidity',
  'temperature_bmp', 'pressure_Pa', 'irradiance', 'estimatedPower', 'expectedLoadVoltage', 'expectedLoadCurrent',
  'estimatedVmp', 'estimatedImp', 'estimatedMppPower'
]);
const CSV_COLUMNS = [
  'ts', 'device_id', 'boot_id', 'seq', 'samples', 'received_at', 'time_estimated',
  'voltage', 'current_A', 'power_W', 'current_ref_A', 'irradiance', 'lux', 'visible', 'infrared',
  'temperature', 'humidity', 'temperature_bmp', 'pressure_Pa', 'gpio23',
  'estimatedPower', 'expectedLoadVoltage', 'expectedLoadCurrent', 'estimatedVmp', 'estimatedImp', 'estimatedMppPower',
  'falha', 'tipo_falha'
];

function toMysqlDateTimeUTC(isoStr) {
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid ISO: ' + isoStr);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
function csvValue(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  return /[;"\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
function csvLine(values) { return values.map(csvValue).join(';') + '\n'; }
function formatCsvCell(column, value) {
  if (value === null || value === undefined) return '';
  if (column.endsWith('_ts') || column === 'ts' || column === 'received_at') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
  }
  return value;
}

app.get('/api/readings', async (req, res) => {
  try {
    const { metric, start, end, maxPoints: maxPointsRaw } = req.query;
    if (!metric || !ALLOWED_METRICS.has(String(metric))) return res.status(400).json({ error: 'metric inválido' });
    if (!start || !end) return res.status(400).json({ error: 'start/end obrigatórios' });
    const maxPoints = maxPointsRaw ? parseInt(maxPointsRaw, 10) : null;
    const startUtc = toMysqlDateTimeUTC(start), endUtc = toMysqlDateTimeUTC(end);
    if (maxPoints && Number.isFinite(maxPoints) && maxPoints > 0) {
      const [countRows] = await dbQuery(`SELECT COUNT(*) AS total FROM readings WHERE \`${metric}\` IS NOT NULL AND ts BETWEEN CONVERT_TZ(?, '+00:00', @@session.time_zone) AND CONVERT_TZ(?, '+00:00', @@session.time_zone)`, [startUtc, endUtc]);
      const totalRows = Number(countRows?.[0]?.total || 0);
      if (totalRows <= maxPoints) {
        const [rows] = await dbQuery(`SELECT ts, \`${metric}\` AS value FROM readings WHERE \`${metric}\` IS NOT NULL AND ts BETWEEN CONVERT_TZ(?, '+00:00', @@session.time_zone) AND CONVERT_TZ(?, '+00:00', @@session.time_zone) ORDER BY ts ASC`, [startUtc, endUtc]);
        return res.json(rows.map((r) => ({ ts: new Date(r.ts).toISOString(), [metric]: r.value == null ? null : Number(r.value) })));
      }
      const totalMs = new Date(end) - new Date(start);
      if (!Number.isFinite(totalMs) || totalMs <= 0) return res.status(400).json({ error: 'Intervalo inválido' });
      const bucketSec = Math.max(1, Math.ceil(Math.max(1, Math.floor(totalMs / 1000)) / maxPoints));
      // Registros decimados (samples > 1) pesam proporcionalmente ao tempo que representam.
      const [rows] = await dbQuery(`
        SELECT bucketStart, SUM(value * w) / SUM(w) AS value FROM (
          SELECT FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(CONVERT_TZ(ts, @@session.time_zone, '+00:00')) / ?) * ?) AS bucketStart, \`${metric}\` AS value, COALESCE(samples, 1) AS w
          FROM readings WHERE \`${metric}\` IS NOT NULL AND ts BETWEEN CONVERT_TZ(?, '+00:00', @@session.time_zone) AND CONVERT_TZ(?, '+00:00', @@session.time_zone)
        ) AS sub GROUP BY bucketStart ORDER BY bucketStart ASC
      `, [bucketSec, bucketSec, startUtc, endUtc]);
      return res.json(rows.map((r) => ({ ts: new Date(r.bucketStart).toISOString(), [metric]: r.value == null ? null : Number(r.value) })));
    }
    const [rows] = await dbQuery(`SELECT ts, \`${metric}\` AS value FROM readings WHERE \`${metric}\` IS NOT NULL AND ts BETWEEN CONVERT_TZ(?, '+00:00', @@session.time_zone) AND CONVERT_TZ(?, '+00:00', @@session.time_zone) ORDER BY ts ASC LIMIT 50000`, [startUtc, endUtc]);
    res.json(rows.map((r) => ({ ts: new Date(r.ts).toISOString(), [metric]: r.value == null ? null : Number(r.value) })));
  } catch (err) {
    logger.error(err, 'Erro /api/readings');
    res.status(500).json({ error: 'Erro interno ao consultar banco.' });
  }
});

// CSV em streaming: as linhas saem do MySQL direto para a resposta, com controle
// de fluxo, sem carregar o período inteiro na memória.
app.get('/api/download', async (req, res) => {
  let conn = null;
  let done = false;
  const finish = (destroy = false) => {
    if (done || !conn) return;
    done = true;
    try { if (destroy) conn.destroy(); else conn.release(); } catch {}
  };
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start/end obrigatórios' });
    const startUtc = toMysqlDateTimeUTC(start), endUtc = toMysqlDateTimeUTC(end);
    const columns = CSV_COLUMNS.map((c) => `\`${c}\``).join(', ');
    conn = await withTimeout(pool.getConnection(), 15000, 'pool');
    const filename = `dados_painel_full_${String(start).slice(0, 10)}_a_${String(end).slice(0, 10)}.csv`;
    const stream = conn.connection.query({
      sql: `SELECT ${columns} FROM readings WHERE ts BETWEEN CONVERT_TZ(?, '+00:00', @@session.time_zone) AND CONVERT_TZ(?, '+00:00', @@session.time_zone) ORDER BY ts ASC`,
      timeout: CSV_QUERY_TIMEOUT_MS
    }, [startUtc, endUtc]).stream({ highWaterMark: 500 });

    let started = false;
    req.on('close', () => { if (!res.writableEnded) { stream.destroy(); finish(true); } });
    stream.on('data', (row) => {
      if (!started) {
        started = true;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.write(csvLine(CSV_COLUMNS));
      }
      if (!res.write(csvLine(CSV_COLUMNS.map((c) => formatCsvCell(c, row[c]))))) {
        stream.pause();
        res.once('drain', () => stream.resume());
      }
    });
    stream.on('end', () => {
      finish();
      if (!started) res.status(204).end(); else res.end();
    });
    stream.on('error', (err) => {
      finish(true);
      logger.error(err, 'Erro /api/download');
      if (!res.headersSent) res.status(500).json({ error: 'Erro ao gerar CSV.' }); else res.end();
    });
  } catch (err) {
    finish(true);
    logger.error(err, 'Erro /api/download');
    if (!res.headersSent) res.status(500).json({ error: 'Erro ao gerar CSV.' }); else res.end();
  }
});

// ===========================================================================
// WhatsApp (Baileys)
// ===========================================================================
// Uma única sessão por vez: a anterior é encerrada antes de reconectar, com
// backoff exponencial (antes, cada queda abria um socket novo sem fechar o velho).
const waLogger = logger.child({ module: 'whatsapp' }, { level: 'warn' });
let sock = null;
let sockUnsubscribe = null;
let waConnected = false;
let waStarting = false;

// Ao reconectar, o WhatsApp reentrega mensagens pendentes/offline com type 'notify'
// e, quando a descriptografia falha, o celular reenvia a mensagem (mesmo id, às vezes
// com horário novo). Sem filtro, um "#status" antigo era respondido a cada reconexão.
// Regra: comando só é executado se for recente E se o id nunca foi tratado. Os ids
// tratados ficam em disco, para valer também depois de reinícios do backend.
const WA_CMD_MAX_AGE_S = 120;
const WA_HANDLED_PATH = process.env.WA_HANDLED_PATH || path.join(path.dirname(ALERT_STATE_PATH), 'whatsapp-handled-cmds.json');
const WA_HANDLED_TTL_MS = 30 * 24 * 3600 * 1000;
const handledWaMsgIds = new Map();  // id -> epoch ms em que foi tratado
try {
  if (fs.existsSync(WA_HANDLED_PATH)) {
    for (const [k, t] of Object.entries(JSON.parse(fs.readFileSync(WA_HANDLED_PATH, 'utf8')))) handledWaMsgIds.set(k, t);
  }
} catch { /* arquivo inválido: recomeça vazio */ }
function saveHandledWaMsgIds() {
  try {
    fs.mkdirSync(path.dirname(WA_HANDLED_PATH), { recursive: true });
    const tmp = `${WA_HANDLED_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(handledWaMsgIds)), 'utf8');
    fs.renameSync(tmp, WA_HANDLED_PATH);
  } catch (err) { logger.error({ err }, 'Erro ao salvar ids de comandos do WhatsApp'); }
}
function shouldHandleWaCommand(m) {
  const id = m.key?.id;
  if (!id || handledWaMsgIds.has(id)) return false;
  // marca o id mesmo quando recusado por idade: um reenvio posterior com horário
  // novo também será ignorado
  const now = Date.now();
  handledWaMsgIds.set(id, now);
  for (const [k, t] of handledWaMsgIds) { if (now - t > WA_HANDLED_TTL_MS || handledWaMsgIds.size > 1000) handledWaMsgIds.delete(k); else break; }
  saveHandledWaMsgIds();
  const rawTs = m.messageTimestamp;
  const ts = Number(typeof rawTs === 'object' && rawTs?.toNumber ? rawTs.toNumber() : rawTs);
  return !!ts && Date.now() / 1000 - ts <= WA_CMD_MAX_AGE_S;
}
let waReconnectTimer = null;
let waBackoffMs = 2000;
let alertJid = null;
const pendingAlerts = [];

async function ensureDir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch {} }

function clearWhatsAppAuth() {
  try {
    for (const f of fs.readdirSync(AUTH_DIR)) fs.rmSync(path.join(AUTH_DIR, f), { recursive: true, force: true });
    logger.warn('Credenciais do WhatsApp apagadas; um novo QR será gerado.');
  } catch (err) { logger.error({ err }, 'Erro ao apagar credenciais do WhatsApp'); }
}

function scheduleWaReconnect(delayMs) {
  clearTimeout(waReconnectTimer);
  waReconnectTimer = setTimeout(() => { startSock().catch((err) => logger.error({ err }, 'Erro WhatsApp')); }, delayMs);
}

function closeSock() {
  if (sockUnsubscribe) { try { sockUnsubscribe(); } catch {} sockUnsubscribe = null; }
  if (sock) { try { sock.end(undefined); } catch {} sock = null; }
  waConnected = false;
}

async function resolveAlertJid() {
  alertJid = null;
  if (!sock) return;
  const self = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
  if (ALERT_WHATSAPP_NUMBER) {
    // Números brasileiros podem estar registrados com ou sem o 9º dígito.
    const full = ALERT_WHATSAPP_NUMBER.startsWith('55') ? ALERT_WHATSAPP_NUMBER : `55${ALERT_WHATSAPP_NUMBER}`;
    const candidates = [full];
    if (full.length === 13 && full[4] === '9') candidates.push(full.slice(0, 4) + full.slice(5));
    for (const c of candidates) {
      try {
        const [r] = await sock.onWhatsApp(c);
        if (r?.exists) { alertJid = jidNormalizedUser(r.jid); break; }
      } catch (err) { waLogger.warn({ err: err.message, c }, 'onWhatsApp falhou'); }
    }
  }
  if (!alertJid) alertJid = self;  // fallback: o próprio número conectado
  logger.info({ alertJid }, 'Destino dos alertas do WhatsApp');
}

async function sendAlert(text) {
  logger.info({ alert: text.split('\n')[0] }, 'Alerta WhatsApp');
  if (!waConnected || !sock || !alertJid) {
    pendingAlerts.push(text);
    if (pendingAlerts.length > 20) pendingAlerts.shift();
    return false;
  }
  try {
    await sock.sendMessage(alertJid, { text });
    return true;
  } catch (err) {
    logger.error({ err: err.message }, 'Falha ao enviar alerta no WhatsApp; ficará na fila');
    pendingAlerts.push(text);
    return false;
  }
}

async function flushPendingAlerts() {
  while (pendingAlerts.length && waConnected) {
    const text = pendingAlerts.shift();
    if (!(await sendAlert(text))) break;
  }
}

async function handleWhatsAppCommand(remoteJid, cmd) {
  if (cmd === '#status') {
    try {
      const [rows] = await dbQuery(`SELECT ts, received_at, device_id, samples, voltage, current_A, power_W, temperature, irradiance, estimatedPower, estimatedMppPower, falha FROM readings ORDER BY ts DESC LIMIT 1`);
      if (!rows.length) { await sock.sendMessage(remoteJid, { text: '📭 Ainda não há leituras.' }); return; }
      const r = rows[0], fmt = (v, suf) => v == null ? '--' : `${Number(v).toFixed(2)}${suf}`;
      const dev = r.device_id ? deviceStatus.get(r.device_id) : null;
      await sock.sendMessage(remoteJid, { text: [
        `📊 Medição: ${formatLocal(new Date(r.ts.replace(' ', 'T') + 'Z'))}`,
        `Tensão: ${fmt(r.voltage, ' V')}`,
        `Corrente: ${fmt(r.current_A, ' A')}`,
        `Potência medida: ${fmt(r.power_W, ' W')}`,
        `Irradiância: ${fmt(r.irradiance, ' W/m²')}`,
        `Potência esperada (${loadResistance} Ω): ${fmt(r.estimatedPower, ' W')}`,
        `MPP estimado: ${fmt(r.estimatedMppPower, ' W')}`,
        `Temperatura: ${fmt(r.temperature, ' °C')}`,
        `Falha: ${r.falha ? 'Ativada' : 'Desativada'}`,
        dev?.buffer ? `Buffer ESP32: ${dev.buffer.pending} registros pendentes` : null
      ].filter(Boolean).join('\n') });
    } catch { await sock.sendMessage(remoteJid, { text: '❌ Erro ao consultar banco.' }); }
    return;
  }
  if (cmd === '#limpezaon' || cmd === '#limpezaoff') {
    if (!mqttClient || !mqttClient.connected) { await sock.sendMessage(remoteJid, { text: '❌ MQTT desconectado.' }); return; }
    const on = cmd === '#limpezaon';
    const payload = JSON.stringify({ thingId: GPIO_THING_ID, sensorData: { GPIO23: on ? 'high' : 'low' } });
    mqttClient.publish(MQTT_PINS_TOPIC, payload, { qos: 1 }, async (err) => {
      await sock.sendMessage(remoteJid, { text: err ? '❌ Falha ao enviar comando.' : `✅ Limpeza ${on ? 'ON' : 'OFF'} enviada.` });
    });
  }
}

async function startSock() {
  if (waStarting) return;
  waStarting = true;
  try {
    closeSock();
    await ensureDir(AUTH_DIR);
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try { ({ version } = await withTimeout(fetchLatestBaileysVersion(), 10000, 'baileys-version')); } catch {}
    const s = makeWASocket({
      ...(version ? { version } : {}),
      logger: waLogger,
      auth: { creds: authState.creds, keys: makeCacheableSignalKeyStore(authState.keys, waLogger) },
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false
    });
    sock = s;
    sockUnsubscribe = s.ev.process(async (events) => {
      if (s !== sock) return;  // eventos de uma sessão antiga
      if (events['connection.update']) {
        const { connection, lastDisconnect, qr } = events['connection.update'];
        if (qr) { lastQR = qr; qrcodeTerminal.generate(qr, { small: true }); }
        if (connection === 'open') {
          lastQR = null;
          waConnected = true;
          waBackoffMs = 2000;
          logger.info({ user: s.user?.id }, '💬 WhatsApp conectado');
          await resolveAlertJid();
          await flushPendingAlerts();
        }
        if (connection === 'close') {
          waConnected = false;
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.loggedOut) {
            logger.warn('WhatsApp desconectado pelo celular (logout).');
            closeSock();
            clearWhatsAppAuth();
            scheduleWaReconnect(2000);
          } else {
            logger.warn({ code, retryInS: Math.round(waBackoffMs / 1000) }, 'WhatsApp caiu; reconectando');
            scheduleWaReconnect(waBackoffMs);
            waBackoffMs = Math.min(waBackoffMs * 2, 5 * 60 * 1000);
          }
        }
      }
      if (events['creds.update']) await saveCreds();
      if (events['messages.upsert']) {
        const upsert = events['messages.upsert'];
        if (upsert.type !== 'notify') return;
        for (const m of upsert.messages) {
          const text = m.message?.conversation || m.message?.extendedTextMessage?.text || m.message?.imageMessage?.caption || '';
          const cmd = String(text).trim().toLowerCase();
          if (!cmd.startsWith('#')) continue;
          if (!shouldHandleWaCommand(m)) {
            logger.info({ cmd, id: m.key?.id, ts: Number(m.messageTimestamp) }, 'Comando WhatsApp antigo/repetido ignorado');
            continue;
          }
          logger.info({ cmd, from: m.key.remoteJid, id: m.key?.id, fromMe: m.key?.fromMe, ts: Number(m.messageTimestamp) }, 'Comando WhatsApp');
          await handleWhatsAppCommand(m.key.remoteJid, cmd).catch((err) => logger.error({ err }, 'Erro comando WhatsApp'));
        }
      }
    });
  } catch (err) {
    logger.error({ err }, 'Erro ao iniciar WhatsApp');
    scheduleWaReconnect(waBackoffMs);
    waBackoffMs = Math.min(waBackoffMs * 2, 5 * 60 * 1000);
  } finally {
    waStarting = false;
  }
}

// ===========================================================================
// Alerta de "painel sem dados" (10 min, 1 h, 3 h, 6 h, 12 h e depois a cada 24 h)
// ===========================================================================
// Estado persistido em disco: reinícios do backend não repetem nem perdem alertas.
const alertState = { lastDataAt: null, outageAlerts: 0, outageStartedAlertAt: null };
let alertStateDirty = false;

function formatLocal(d) {
  return new Date(d).toLocaleString('pt-BR', { timeZone: ALERT_TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440), h = Math.floor((totalMin % 1440) / 60), m = totalMin % 60;
  const parts = [];
  if (d) parts.push(`${d} dia${d > 1 ? 's' : ''}`);
  if (h) parts.push(`${h} h`);
  if (m && !d) parts.push(`${m} min`);
  return parts.join(' ') || 'menos de 1 min';
}

function outageThresholdMs(k) {
  if (k < OUTAGE_ALERT_STEPS_MIN.length) return OUTAGE_ALERT_STEPS_MIN[k] * 60000;
  return (k - OUTAGE_ALERT_STEPS_MIN.length + 1) * OUTAGE_DAILY_MIN * 60000;  // 24 h, 48 h, 72 h...
}

function thresholdsPassed(ageMs) {
  let k = 0;
  while (ageMs >= outageThresholdMs(k)) k += 1;
  return k;
}

function saveAlertState(force = false) {
  if (!force && !alertStateDirty) return;
  try {
    fs.mkdirSync(path.dirname(ALERT_STATE_PATH), { recursive: true });
    const tmp = `${ALERT_STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(alertState), 'utf8');
    fs.renameSync(tmp, ALERT_STATE_PATH);
    alertStateDirty = false;
  } catch (err) { logger.error({ err }, 'Erro ao salvar estado de alertas'); }
}

async function loadAlertState() {
  try {
    if (fs.existsSync(ALERT_STATE_PATH)) Object.assign(alertState, JSON.parse(fs.readFileSync(ALERT_STATE_PATH, 'utf8')));
  } catch (err) { logger.warn({ err }, 'Estado de alertas inválido; recomeçando'); }
  if (!alertState.lastDataAt) {
    try {
      const [rows] = await dbQuery('SELECT MAX(ts) AS last FROM readings', [], 10000);
      const last = rows?.[0]?.last;
      alertState.lastDataAt = last ? Date.parse(String(last).replace(' ', 'T') + 'Z') : Date.now();
    } catch { alertState.lastDataAt = Date.now(); }
    alertStateDirty = true;
  }
}

function devicePendingInfo(deviceId) {
  const st = deviceId ? deviceStatus.get(deviceId) : null;
  return st?.buffer ? `\nBuffer do ESP32: ${st.buffer.pending} registros pendentes.` : '';
}

function markDataReceived(deviceId, at = new Date()) {
  const prevLast = alertState.lastDataAt;
  alertState.lastDataAt = at.getTime();
  alertStateDirty = true;
  if (alertState.outageAlerts > 0) {
    const downFor = prevLast ? at.getTime() - prevLast : null;
    alertState.outageAlerts = 0;
    alertState.outageStartedAlertAt = null;
    saveAlertState(true);
    sendAlert(`✅ Painel Fotovoltaico: conexão restabelecida.\nVoltou a receber dados em ${formatLocal(at)}${downFor ? `, após ${formatDuration(downFor)} sem dados` : ''}.\nOs dados guardados no ESP32 durante a queda estão sendo enviados.`);
  }
}

function checkOutage() {
  if (!alertState.lastDataAt) return;
  const age = Date.now() - alertState.lastDataAt;
  const passed = thresholdsPassed(age);
  if (passed > alertState.outageAlerts) {
    alertState.outageAlerts = passed;
    alertStateDirty = true;
    saveAlertState(true);
    const dev = [...knownDevices][0];
    sendAlert(`⚠️ Painel Fotovoltaico: sem receber dados há ${formatDuration(age)}.\nÚltimo dado: ${formatLocal(alertState.lastDataAt)}.${devicePendingInfo(dev)}\nO ESP32 guarda as medições na flash e reenvia quando a conexão voltar.`);
  }
}

// ===========================================================================
// Inicialização
// ===========================================================================
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException: encerrando para o Docker reiniciar');
  saveAlertState(true);
  setTimeout(() => process.exit(1), 200);
});
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { saveAlertState(true); process.exit(0); });
}

(async () => {
  await initDb();
  await loadAlertState();
  initMqtt();
  startSock().catch((err) => logger.error(err, 'Erro WhatsApp'));
  setInterval(checkOutage, ALERT_CHECK_MS);
  setInterval(() => saveAlertState(), 60000);
  app.get('/qr', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const head = '<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5">';
      if (waConnected) return res.status(200).send(`<html><head>${head}</head><body style="font-family:sans-serif;text-align:center"><h2>WhatsApp conectado ✅</h2><p>${sock?.user?.id ? jidNormalizedUser(sock.user.id).split('@')[0] : ''}</p><p>Alertas para: ${alertJid ? alertJid.split('@')[0] : '--'}</p><p><a href="/">Voltar</a></p></body></html>`);
      if (!lastQR) return res.status(200).send(`<html><head>${head}</head><body style="font-family:sans-serif;text-align:center"><h2>WhatsApp — QR</h2><p>Aguardando QR… (a página atualiza sozinha)</p></body></html>`);
      const dataUrl = await QRCode.toDataURL(lastQR, { scale: 8, margin: 1 });
      res.status(200).send(`<html><head>${head}</head><body style="font-family:sans-serif;text-align:center"><h2>Escaneie com o WhatsApp</h2><p>WhatsApp → Dispositivos conectados → Conectar dispositivo</p><img src="${dataUrl}" style="max-width:90vw"/><p>O código muda a cada ~20 s; a página atualiza sozinha.</p></body></html>`);
    } catch { res.status(500).send('Erro ao gerar QR.'); }
  });
  app.listen(Number(PORT), () => {
    logger.info(`🚀 Server web em http://localhost:${PORT}`);
    logger.info('Live View SSE: GET /api/live');
  });
})();
