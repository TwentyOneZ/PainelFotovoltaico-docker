// server-v2.js
// Backend: Express, MySQL, MQTT, SSE Live View e WhatsApp (Baileys)

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
const CONFIG_INI_PATH = path.join(__dirname, 'config.ini');

const defaultIniContent = `# Configurações do painel fotovoltaico e backend
# Gerado automaticamente se não existir.

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
LOG_LEVEL = info
GPIO_THING_ID = painelfotovoltaico.gerador:GPIO
MQTT_ESTIMATED_POWER_TOPIC = /painelfotovoltaico.referencia/estimatedPower
MQTT_PV_CONFIG_CMD_TOPIC = /painelfotovoltaico.node/pvConfig
ESTIMATED_POWER_THING_ID = painelfotovoltaico.node:estimatedPower
MQTT_ALL_TOPIC = /painelfotovoltaico.node/all
ALL_THING_ID = painelfotovoltaico.node:all
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
  const lines = ['# Arquivo gerado automaticamente. Edite com cuidado.', ''];
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
  DB_PASS = appCfg.DB_PASS || 'RunicK137',
  DB_NAME = appCfg.DB_NAME || 'painelSolar',
  MQTT_URL = appCfg.MQTT_URL || 'mqtt://cerise.freeddns.org:30001',
  MQTT_USER = appCfg.MQTT_USER || 'infinitwin_user',
  MQTT_PASS = appCfg.MQTT_PASS || 'IwtLab#2025!',
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
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let falhaState = 0;
let lastGeneratorReceivedAt = null;
let lastReferenceReceivedAt = null;

const state = {
  voltage: null,
  current_mA: null,
  power_mW: null,
  lux: null,
  temperature: null,
  humidity: null,
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
let kv = vmp0 / voc0;
let ki = imp0 / isc0;
let contadorIncompleto = 0;

const insertBuffer = [];
const BUFFER_INTERVAL_MS = 5000;
let pool;

async function ensureColumn(name, definition) {
  try { await pool.query(`ALTER TABLE readings ADD COLUMN \`${name}\` ${definition}`); }
  catch (err) { if (err.code !== 'ER_DUP_FIELDNAME') throw err; }
}

async function ensureIndex(name, expression) {
  try { await pool.query(`CREATE INDEX \`${name}\` ON readings (${expression})`); }
  catch (err) { if (err.code !== 'ER_DUP_KEYNAME') throw err; }
}

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

  await pool.query(`
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
      falha TINYINT(1) DEFAULT 0,
      INDEX idx_ts (ts)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await ensureColumn('falha', 'TINYINT(1) DEFAULT 0');
  await ensureColumn('heartbeat_ts', 'DATETIME(3) NULL');
  await ensureColumn('generator_last_received_ts', 'DATETIME(3) NULL');
  await ensureColumn('reference_last_received_ts', 'DATETIME(3) NULL');
  await ensureColumn('expectedLoadVoltage', 'DOUBLE NULL');
  await ensureColumn('expectedLoadCurrent', 'DOUBLE NULL');
  await ensureColumn('estimatedVmp', 'DOUBLE NULL');
  await ensureColumn('estimatedImp', 'DOUBLE NULL');
  await ensureColumn('estimatedMppPower', 'DOUBLE NULL');
  await ensureIndex('idx_heartbeat_ts', '`heartbeat_ts`');

  try {
    const [rows] = await pool.query('SELECT falha FROM readings ORDER BY ts DESC LIMIT 1');
    if (rows.length) falhaState = rows[0].falha || 0;
  } catch (err) {
    logger.error(err, 'Erro ao carregar estado inicial de falha');
  }

  logger.info('🗄️ Tabela readings pronta com heartbeat e timestamps de origem.');
  setInterval(flushInsertBuffer, BUFFER_INTERVAL_MS);
}

async function flushInsertBuffer() {
  if (!pool || insertBuffer.length === 0) return;
  const batchData = insertBuffer.splice(0, insertBuffer.length);
  try {
    await pool.query(`
      INSERT INTO readings (
        ts, heartbeat_ts, generator_last_received_ts, reference_last_received_ts,
        voltage, current_mA, power_mW, lux, temperature, humidity, irradiance,
        estimatedPower, expectedLoadVoltage, expectedLoadCurrent,
        estimatedVmp, estimatedImp, estimatedMppPower, falha
      ) VALUES ?
    `, [batchData]);
    logger.debug(`Gravou lote de ${batchData.length} heartbeats no banco.`);
  } catch (err) {
    insertBuffer.unshift(...batchData);
    logger.error({ err, pending: insertBuffer.length }, 'Erro ao gravar lote; dados recolocados na fila.');
  }
}

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

function calculateEstimatedPowerFromState({ publish = true } = {}) {
  const T = state.temperature;
  const G = state.irradiance;
  if (T == null || G == null) { contadorIncompleto += 1; return null; }
  if (G <= 0) {
    state.estimatedPower = 0;
    state.expectedLoadVoltage = 0;
    state.expectedLoadCurrent = 0;
    state.estimatedVmp = 0;
    state.estimatedImp = 0;
    state.estimatedMppPower = 0;
    return 0;
  }
  const model = buildPvModel(Math.max(G, 0), T);
  if (!model.valid) { logger.warn({ G, T }, 'Modelo FV inválido.'); return null; }
  const loadPoint = solveResistiveLoadPoint(model, loadResistance);
  if (!loadPoint) { logger.warn({ G, T, loadResistance }, 'Falha ao resolver painel × carga.'); return null; }

  state.expectedLoadVoltage = loadPoint.voltage;
  state.expectedLoadCurrent = loadPoint.current;
  state.estimatedPower = loadPoint.power;
  state.estimatedVmp = model.vmp;
  state.estimatedImp = model.imp;
  state.estimatedMppPower = model.vmp * model.imp;

  if (publish && mqttClient && mqttClient.connected) {
    const payload = JSON.stringify({
      thingId: ESTIMATED_POWER_THING_ID,
      sensorData: {
        estimatedPower: Number(state.estimatedPower.toFixed(3)),
        expectedLoadVoltage: Number(state.expectedLoadVoltage.toFixed(4)),
        expectedLoadCurrent: Number(state.expectedLoadCurrent.toFixed(6)),
        estimatedVmp: Number(state.estimatedVmp.toFixed(4)),
        estimatedImp: Number(state.estimatedImp.toFixed(6)),
        estimatedMppPower: Number(state.estimatedMppPower.toFixed(3)),
        loadResistance
      }
    });
    mqttClient.publish(MQTT_ESTIMATED_POWER_TOPIC, payload, { qos: 1 }, (err) => {
      if (err) logger.error({ err, topic: MQTT_ESTIMATED_POWER_TOPIC }, 'Erro ao publicar referência estimada.');
    });
  }
  return state.estimatedPower;
}

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
    current_mA: snapshot.current_mA,
    power_mW: snapshot.power_mW,
    lux: snapshot.lux,
    temperature: snapshot.temperature,
    humidity: snapshot.humidity,
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
  liveClients.add(res);
  const keepAlive = setInterval(() => { if (!res.destroyed) res.write(`: keepalive ${Date.now()}\n\n`); }, 15000);
  req.on('close', () => { clearInterval(keepAlive); liveClients.delete(res); });
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

let mqttClient;
let stateChangedSinceLastTick = false;

function publishAllIfChanged() {
  if (!mqttClient || !mqttClient.connected || !stateChangedSinceLastTick) return;
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
      estimatedPower: state.estimatedPower,
      expectedLoadVoltage: state.expectedLoadVoltage,
      expectedLoadCurrent: state.expectedLoadCurrent,
      estimatedVmp: state.estimatedVmp,
      estimatedImp: state.estimatedImp,
      estimatedMppPower: state.estimatedMppPower,
      generator_last_received_ts: isoOrNull(lastGeneratorReceivedAt),
      reference_last_received_ts: isoOrNull(lastReferenceReceivedAt)
    }
  };
  mqttClient.publish(MQTT_ALL_TOPIC, JSON.stringify(payload), { qos: 0 }, (err) => {
    if (err) logger.error({ err, topic: MQTT_ALL_TOPIC }, 'Erro ao publicar /all');
  });
  stateChangedSinceLastTick = false;
}

function applyPvConfig(sensorData) {
  const fields = ['voc0','isc0','vmp0','imp0','alphav','alphai','G0','T0','q','kConst','Ns','loadResistance'];
  const updated = {};
  for (const key of fields) {
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
  for (const key of fields) if (updated[key] !== undefined) iniConfig.pv[key] = String(updated[key]);
  fs.writeFileSync(CONFIG_INI_PATH, buildIni(iniConfig), 'utf8');
  calculateEstimatedPowerFromState({ publish: false });
  return updated;
}

function initMqtt() {
  mqttClient = mqtt.connect(MQTT_URL, { username: MQTT_USER, password: MQTT_PASS });
  mqttClient.on('connect', () => {
    logger.info({ MQTT_URL, MQTT_USER }, '📡 MQTT conectado');
    mqttClient.subscribe(MQTT_TOPICS, (err) => err ? logger.error(err, 'Erro subscribe') : logger.info({ topics: MQTT_TOPICS }, 'Tópicos assinados'));
  });
  mqttClient.on('error', (err) => logger.error({ err }, 'Erro MQTT'));
  mqttClient.on('message', (topic, payloadBuf) => {
    const receivedAt = new Date();
    let data;
    try { data = JSON.parse(payloadBuf.toString('utf8').trim()); }
    catch { logger.warn({ topic }, 'Payload MQTT inválido'); return; }
    if (!topic.toLowerCase().startsWith('/ditto/events/painelfotovoltaico.')) return;
    const { thingId, sensorData } = data || {};
    if (!thingId || !sensorData || typeof sensorData !== 'object') return;
    try {
      switch (thingId) {
        case 'INA226':
          lastGeneratorReceivedAt = receivedAt;
          if (typeof sensorData.voltage === 'number') state.voltage = sensorData.voltage;
          if (typeof sensorData.current === 'number') state.current_mA = sensorData.current;
          if (typeof sensorData.power === 'number') state.power_mW = sensorData.power;
          stateChangedSinceLastTick = true;
          break;
        case 'TSL2591':
          if (typeof sensorData.lux === 'number') { state.lux = sensorData.lux; stateChangedSinceLastTick = true; }
          break;
        case 'AHT20':
          if (typeof sensorData.temperature === 'number') state.temperature = sensorData.temperature;
          if (typeof sensorData.humidity === 'number') state.humidity = sensorData.humidity;
          stateChangedSinceLastTick = true;
          break;
        case 'BMP280': break;
        case 'GPIO': logger.info({ gpio23: sensorData.GPIO23 }, 'GPIO recebido'); break;
        case 'esp32':
          if (typeof sensorData.irradiance === 'number') {
            lastReferenceReceivedAt = receivedAt;
            state.irradiance = sensorData.irradiance;
            stateChangedSinceLastTick = true;
          }
          break;
        case 'estimatedPower': break;
        case 'pvConfig': logger.info({ updated: applyPvConfig(sensorData) }, 'PV config atualizada'); break;
        default: logger.debug({ thingId }, 'thingId não mapeado');
      }
    } catch (err) { logger.error({ err, thingId }, 'Erro ao processar MQTT'); }
  });
}

function captureHeartbeat() {
  const heartbeat = new Date();
  calculateEstimatedPowerFromState({ publish: true });
  publishAllIfChanged();
  const snapshot = {
    heartbeat_ts: heartbeat,
    generator_last_received_ts: lastGeneratorReceivedAt ? new Date(lastGeneratorReceivedAt) : null,
    reference_last_received_ts: lastReferenceReceivedAt ? new Date(lastReferenceReceivedAt) : null,
    voltage: state.voltage,
    current_mA: state.current_mA,
    power_mW: state.power_mW,
    lux: state.lux == null ? 0 : state.lux,
    temperature: state.temperature,
    humidity: state.humidity,
    irradiance: state.irradiance,
    estimatedPower: state.estimatedPower,
    expectedLoadVoltage: state.expectedLoadVoltage,
    expectedLoadCurrent: state.expectedLoadCurrent,
    estimatedVmp: state.estimatedVmp,
    estimatedImp: state.estimatedImp,
    estimatedMppPower: state.estimatedMppPower,
    falha: falhaState
  };
  insertBuffer.push([
    heartbeat, heartbeat, snapshot.generator_last_received_ts, snapshot.reference_last_received_ts,
    snapshot.voltage, snapshot.current_mA, snapshot.power_mW, snapshot.lux, snapshot.temperature,
    snapshot.humidity, snapshot.irradiance, snapshot.estimatedPower, snapshot.expectedLoadVoltage,
    snapshot.expectedLoadCurrent, snapshot.estimatedVmp, snapshot.estimatedImp, snapshot.estimatedMppPower,
    snapshot.falha
  ]);
  broadcastHeartbeat(rememberHeartbeat(snapshot));
}

app.get('/api/pv-config', (req, res) => res.json({
  voc0, isc0, vmp0, imp0, alphav: alphav * 100, alphai: alphai * 100,
  G0, T0, q, kConst, Ns, loadResistance
}));

app.post('/api/pv-config', (req, res) => {
  const fields = ['voc0','isc0','vmp0','imp0','alphav','alphai','G0','T0','q','kConst','Ns','loadResistance'];
  const sensorData = {};
  try {
    for (const key of fields) {
      if (req.body?.[key] === undefined) continue;
      const n = Number(req.body[key]);
      if (!Number.isFinite(n)) return res.status(400).json({ error: `Valor inválido para ${key}.` });
      sensorData[key] = n;
    }
    if (!Object.keys(sensorData).length) return res.status(400).json({ error: 'Nenhum parâmetro fornecido.' });
    const updated = applyPvConfig(sensorData);
    if (mqttClient && mqttClient.connected) {
      mqttClient.publish(MQTT_PV_CONFIG_CMD_TOPIC, JSON.stringify({ thingId: 'painelfotovoltaico.node:pvConfig', sensorData }), { qos: 1 }, (err) => {
        if (err) logger.error({ err }, 'Falha ao publicar pvConfig; local já aplicado');
      });
    }
    res.json({ ok: true, updated });
  } catch (err) {
    logger.error(err, 'Erro pv-config');
    res.status(400).json({ error: err.message || 'Erro PV config' });
  }
});

app.get('/api/falha', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT falha FROM readings ORDER BY ts DESC LIMIT 1');
    res.json({ falha: rows.length ? (rows[0].falha || 0) : falhaState });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar falha' }); }
});
app.post('/api/falha', (req, res) => { falhaState = req.body?.falha ? 1 : 0; res.json({ ok: true, falha: falhaState }); });

const ALLOWED_METRICS = new Set([
  'voltage','current_mA','power_mW','lux','temperature','humidity','irradiance',
  'estimatedPower','expectedLoadVoltage','expectedLoadCurrent','estimatedVmp','estimatedImp','estimatedMppPower'
]);
const CSV_COLUMNS = [
  'ts','heartbeat_ts','generator_last_received_ts','reference_last_received_ts',
  'voltage','current_mA','power_mW','lux','temperature','humidity','irradiance',
  'estimatedPower','expectedLoadVoltage','expectedLoadCurrent','estimatedVmp','estimatedImp','estimatedMppPower','falha'
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
  if (column.endsWith('_ts') || column === 'ts') {
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
      const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM readings WHERE \`${metric}\` IS NOT NULL AND ts BETWEEN CONVERT_TZ(?, '+00:00', @@session.time_zone) AND CONVERT_TZ(?, '+00:00', @@session.time_zone)`, [startUtc, endUtc]);
      const totalRows = Number(countRows?.[0]?.total || 0);
      if (totalRows <= maxPoints) {
        const [rows] = await pool.query(`SELECT ts, \`${metric}\` AS value FROM readings WHERE \`${metric}\` IS NOT NULL AND ts BETWEEN CONVERT_TZ(?, '+00:00', @@session.time_zone) AND CONVERT_TZ(?, '+00:00', @@session.time_zone) ORDER BY ts ASC`, [startUtc, endUtc]);
        return res.json(rows.map((r) => ({ ts: new Date(r.ts).toISOString(), [metric]: r.value == null ? null : Number(r.value) })));
      }
      const totalMs = new Date(end) - new Date(start);
      if (!Number.isFinite(totalMs) || totalMs <= 0) return res.status(400).json({ error: 'Intervalo inválido' });
      const bucketSec = Math.max(1, Math.ceil(Math.max(1, Math.floor(totalMs / 1000)) / maxPoints));
      const [rows] = await pool.query(`
        SELECT bucketStart, AVG(value) AS value FROM (
          SELECT FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(CONVERT_TZ(ts, @@session.time_zone, '+00:00')) / ?) * ?) AS bucketStart, \`${metric}\` AS value
          FROM readings WHERE \`${metric}\` IS NOT NULL AND ts BETWEEN CONVERT_TZ(?, '+00:00', @@session.time_zone) AND CONVERT_TZ(?, '+00:00', @@session.time_zone)
        ) AS sub GROUP BY bucketStart ORDER BY bucketStart ASC
      `, [bucketSec, bucketSec, startUtc, endUtc]);
      return res.json(rows.map((r) => ({ ts: new Date(r.bucketStart).toISOString(), [metric]: r.value == null ? null : Number(r.value) })));
    }
    const [rows] = await pool.query(`SELECT ts, \`${metric}\` AS value FROM readings WHERE \`${metric}\` IS NOT NULL AND ts BETWEEN CONVERT_TZ(?, '+00:00', @@session.time_zone) AND CONVERT_TZ(?, '+00:00', @@session.time_zone) ORDER BY ts ASC LIMIT 50000`, [startUtc, endUtc]);
    res.json(rows.map((r) => ({ ts: new Date(r.ts).toISOString(), [metric]: r.value == null ? null : Number(r.value) })));
  } catch (err) {
    logger.error(err, 'Erro /api/readings');
    res.status(500).json({ error: 'Erro interno ao consultar banco.' });
  }
});

app.get('/api/download', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start/end obrigatórios' });
    const startUtc = toMysqlDateTimeUTC(start), endUtc = toMysqlDateTimeUTC(end);
    const columns = CSV_COLUMNS.map((c) => `\`${c}\``).join(', ');
    const [rows] = await pool.query(`SELECT ${columns} FROM readings WHERE ts BETWEEN CONVERT_TZ(?, '+00:00', @@session.time_zone) AND CONVERT_TZ(?, '+00:00', @@session.time_zone) ORDER BY ts ASC`, [startUtc, endUtc]);
    if (!rows.length) return res.status(204).end();
    const filename = `dados_painel_full_${String(start).slice(0,10)}_a_${String(end).slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.write(csvLine(CSV_COLUMNS));
    for (const row of rows) res.write(csvLine(CSV_COLUMNS.map((c) => formatCsvCell(c, row[c]))));
    res.end();
  } catch (err) {
    logger.error(err, 'Erro /api/download');
    if (!res.headersSent) res.status(500).json({ error: 'Erro ao gerar CSV.' }); else res.end();
  }
});

async function ensureDir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch {} }
async function startSock() {
  await ensureDir(AUTH_DIR);
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    logger,
    auth: { creds: authState.creds, keys: makeCacheableSignalKeyStore(authState.keys, logger) },
    generateHighQualityLinkPreview: false
  });
  sock.ev.process(async (events) => {
    if (events['connection.update']) {
      const { connection, lastDisconnect, qr } = events['connection.update'];
      if (qr) { lastQR = qr; qrcodeTerminal.generate(qr, { small: true }); }
      if (connection === 'open') lastQR = null;
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) startSock();
      }
    }
    if (events['creds.update']) await saveCreds();
    if (events['messages.upsert']) {
      const upsert = events['messages.upsert'];
      if (upsert.type !== 'notify') return;
      for (const m of upsert.messages) {
        const remoteJid = m.key.remoteJid;
        const text = m.message?.conversation || m.message?.extendedTextMessage?.text || m.message?.imageMessage?.caption || '';
        const cmd = String(text).trim().toLowerCase();
        if (cmd === '#status') {
          try {
            const [rows] = await pool.query(`SELECT ts, heartbeat_ts, generator_last_received_ts, reference_last_received_ts, voltage, current_mA, power_mW, temperature, irradiance, estimatedPower, estimatedMppPower, falha FROM readings ORDER BY ts DESC LIMIT 1`);
            if (!rows.length) { await sock.sendMessage(remoteJid, { text: '📭 Ainda não há leituras.' }); continue; }
            const r = rows[0], fmt = (v, suf) => v == null ? '--' : `${Number(v).toFixed(2)}${suf}`;
            await sock.sendMessage(remoteJid, { text: [
              `📊 Heartbeat: ${r.heartbeat_ts || r.ts}`,
              `Gerador recebido: ${r.generator_last_received_ts || '--'}`,
              `Referência recebida: ${r.reference_last_received_ts || '--'}`,
              `Tensão: ${fmt(r.voltage, ' V')}`,
              `Corrente: ${fmt(r.current_mA, ' A')}`,
              `Potência medida: ${fmt(r.power_mW, ' W')}`,
              `Irradiância: ${fmt(r.irradiance, ' W/m²')}`,
              `Potência esperada (${loadResistance} Ω): ${fmt(r.estimatedPower, ' W')}`,
              `MPP estimado: ${fmt(r.estimatedMppPower, ' W')}`,
              `Temperatura: ${fmt(r.temperature, ' °C')}`,
              `Falha: ${r.falha ? 'Ativada' : 'Desativada'}`
            ].join('\n') });
          } catch { await sock.sendMessage(remoteJid, { text: '❌ Erro ao consultar banco.' }); }
          continue;
        }
        if (cmd === '#limpezaon' || cmd === '#limpezaoff') {
          if (!mqttClient || !mqttClient.connected) { await sock.sendMessage(remoteJid, { text: '❌ MQTT desconectado.' }); continue; }
          const on = cmd === '#limpezaon';
          const payload = JSON.stringify({ thingId: GPIO_THING_ID, sensorData: { GPIO23: on ? 'high' : 'low' } });
          mqttClient.publish(MQTT_PINS_TOPIC, payload, { qos: 1 }, async (err) => {
            await sock.sendMessage(remoteJid, { text: err ? '❌ Falha ao enviar comando.' : `✅ Limpeza ${on ? 'ON' : 'OFF'} enviada.` });
          });
        }
      }
    }
  });
  return sock;
}

(async () => {
  await initDb();
  initMqtt();
  setInterval(() => { try { captureHeartbeat(); } catch (err) { logger.error(err, 'Erro heartbeat 1 Hz'); } }, 1000);
  startSock().catch((err) => logger.error(err, 'Erro WhatsApp'));
  app.get('/qr', async (req, res) => {
    try {
      if (!lastQR) return res.status(200).send('<html><body><h2>WhatsApp — QR</h2><p>Nenhum QR ativo.</p><p><a href="/">Voltar</a></p></body></html>');
      const dataUrl = await QRCode.toDataURL(lastQR, { scale: 8, margin: 1 });
      res.status(200).send(`<html><body style="text-align:center"><h2>Escaneie o QR</h2><img src="${dataUrl}"/><p><a href="/">Voltar</a></p></body></html>`);
    } catch { res.status(500).send('Erro ao gerar QR.'); }
  });
  app.listen(Number(PORT), () => {
    logger.info(`🚀 Server web em http://localhost:${PORT}`);
    logger.info('Live View SSE: GET /api/live');
  });
})();
