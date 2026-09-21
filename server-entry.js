// server-entry.js
// Extends server-v2 with backend-managed timed fault injection and fault-type metadata.
// server-v2 remains the source of truth for the PV acquisition/backend.

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const expressPath = require.resolve('express');
const realExpress = require(expressPath);
let capturedApp = null;
let mirroredFalhaState = null;
let mirroredFaultType = null;

const CONFIG_INI_PATH = path.join(__dirname, 'config.ini');
const TIMER_STATE_PATH = process.env.FALHA_TIMER_STATE_PATH || '/data/falha-timer.json';
const SERVER_PORT = Number(process.env.PORT || 4000);
const MAX_TIMED_FAULT_SECONDS = 7 * 24 * 60 * 60;
const MAX_FAULT_TYPE_LENGTH = 255;

let faultDbPool = null;
let faultDbInitPromise = null;
let autoOffAt = null;
let autoOffTimer = null;
let timedFaultType = null;
let expiryInProgress = false;

function normalizeFaultType(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, MAX_FAULT_TYPE_LENGTH);
}

function readAppConfig() {
  const out = {};
  try {
    if (!fs.existsSync(CONFIG_INI_PATH)) return out;
    const raw = fs.readFileSync(CONFIG_INI_PATH, 'utf8');
    let section = null;
    for (let line of raw.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      if (line.startsWith('[') && line.endsWith(']')) {
        section = line.slice(1, -1).trim();
        continue;
      }
      if (section !== 'app') continue;
      const idx = line.indexOf('=');
      if (idx < 0) continue;
      out[line.slice(0, idx).trim()] = line.slice(idx + 1).split(/\s+[;#]/, 1)[0].trim();
    }
  } catch (err) {
    console.error('[falha-tipo] Não foi possível ler config.ini:', err);
  }
  return out;
}

async function ensureFaultMetadataDb() {
  if (faultDbPool) return faultDbPool;
  if (faultDbInitPromise) return faultDbInitPromise;

  faultDbInitPromise = (async () => {
    const appCfg = readAppConfig();
    const pool = mysql.createPool({
      host: process.env.DB_HOST || appCfg.DB_HOST || 'mysql',
      port: Number(process.env.DB_PORT || appCfg.DB_PORT || 3306),
      user: process.env.DB_USER || appCfg.DB_USER || 'root',
      password: process.env.DB_PASS || appCfg.DB_PASS || '',
      database: process.env.DB_NAME || appCfg.DB_NAME || 'painelSolar',
      connectionLimit: 3,
      dateStrings: true
    });

    let lastError;
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      try {
        await pool.query('SELECT 1');
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (lastError) {
      await pool.end().catch(() => {});
      throw lastError;
    }

    try {
      await pool.query('ALTER TABLE readings ADD COLUMN tipo_falha VARCHAR(255) NULL');
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS fault_intervals (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        started_at DATETIME(3) NOT NULL,
        ended_at DATETIME(3) NULL,
        tipo_falha VARCHAR(255) NULL,
        INDEX idx_fault_intervals_started (started_at),
        INDEX idx_fault_intervals_window (started_at, ended_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // The readings are buffered for ~5 s before INSERT. A fault interval history is
    // therefore used instead of simply reading the current fault type at flush time.
    // This makes each buffered heartbeat receive the type that was active at its own ts.
    await pool.query('DROP TRIGGER IF EXISTS trg_readings_tipo_falha_bi');
    await pool.query(`
      CREATE TRIGGER trg_readings_tipo_falha_bi
      BEFORE INSERT ON readings
      FOR EACH ROW
      BEGIN
        IF NEW.falha = 1 THEN
          SET NEW.tipo_falha = (
            SELECT fi.tipo_falha
            FROM fault_intervals fi
            WHERE NEW.ts >= fi.started_at
              AND (fi.ended_at IS NULL OR NEW.ts < fi.ended_at)
            ORDER BY fi.started_at DESC
            LIMIT 1
          );
        ELSE
          SET NEW.tipo_falha = NULL;
        END IF;
      END
    `);

    try {
      const [rows] = await pool.query(
        'SELECT falha, tipo_falha FROM readings ORDER BY ts DESC, id DESC LIMIT 1'
      );
      if (rows.length) {
        mirroredFalhaState = rows[0].falha ? 1 : 0;
        mirroredFaultType = mirroredFalhaState ? normalizeFaultType(rows[0].tipo_falha) : null;
      }
    } catch (err) {
      console.error('[falha-tipo] Não foi possível carregar estado inicial:', err);
    }

    faultDbPool = pool;
    console.log('[falha-tipo] Coluna tipo_falha e histórico de intervalos prontos.');
    return pool;
  })();

  try {
    return await faultDbInitPromise;
  } catch (err) {
    faultDbInitPromise = null;
    throw err;
  }
}

async function recordFaultTransition(desiredState, requestedType) {
  const pool = await ensureFaultMetadataDb();
  const desired = desiredState ? 1 : 0;
  const type = desired ? normalizeFaultType(requestedType) : null;
  const now = new Date();

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (desired) {
      // Starting a new fault or changing its description while it is active creates
      // a new interval, so buffered 1 Hz heartbeats remain historically correct.
      if (mirroredFalhaState !== 1 || mirroredFaultType !== type) {
        await conn.query(
          'UPDATE fault_intervals SET ended_at = ? WHERE ended_at IS NULL',
          [now]
        );
        await conn.query(
          'INSERT INTO fault_intervals (started_at, ended_at, tipo_falha) VALUES (?, NULL, ?)',
          [now, type]
        );
      }
    } else {
      await conn.query(
        'UPDATE fault_intervals SET ended_at = ? WHERE ended_at IS NULL',
        [now]
      );
    }

    await conn.commit();
    mirroredFalhaState = desired;
    mirroredFaultType = desired ? type : null;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }

  return { falha: mirroredFalhaState, tipo_falha: mirroredFaultType };
}

function wrappedExpress(...args) {
  const app = realExpress(...args);
  capturedApp = app;

  // server-v2's legacy GET reads the last persisted heartbeat. Because writes are
  // batched, the endpoint can lag a few seconds. The mirrored state reflects the
  // effective in-memory state immediately and now also exposes tipo_falha.
  const originalGet = app.get.bind(app);
  const originalPost = app.post.bind(app);

  app.get = function wrappedGet(route, ...handlers) {
    if (route === '/api/falha' && handlers.length > 0) {
      const legacyHandler = handlers[0];
      return originalGet(route, async (req, res, next) => {
        try {
          await ensureFaultMetadataDb();
          if (mirroredFalhaState !== null) {
            return res.json({
              falha: mirroredFalhaState,
              tipo_falha: mirroredFalhaState ? mirroredFaultType : null
            });
          }
        } catch (err) {
          console.error('[falha-tipo] Falha ao ler estado espelhado:', err);
        }
        return legacyHandler(req, res, next);
      }, ...handlers.slice(1));
    }
    return originalGet(route, ...handlers);
  };

  app.post = function wrappedPost(route, ...handlers) {
    if (route === '/api/falha' && handlers.length > 0) {
      const legacyHandler = handlers[0];
      return originalPost(route, async (req, res, next) => {
        const desired = req.body?.falha ? 1 : 0;
        // If a caller turns an already-active fault on without resending the type,
        // preserve the existing description instead of silently erasing it.
        const requestedType = desired
          ? (Object.prototype.hasOwnProperty.call(req.body || {}, 'tipo_falha')
              ? req.body.tipo_falha
              : mirroredFaultType)
          : null;

        try {
          await recordFaultTransition(desired, requestedType);
        } catch (err) {
          console.error('[falha-tipo] Não foi possível registrar tipo/intervalo da falha:', err);
          return res.status(503).json({ error: 'Não foi possível registrar o tipo da falha no MySQL.' });
        }

        return legacyHandler(req, res, next);
      }, ...handlers.slice(1));
    }
    return originalPost(route, ...handlers);
  };

  return app;
}
Object.assign(wrappedExpress, realExpress);

// Inject the additional fault UI without duplicating the main dashboard file.
wrappedExpress.static = function timedFaultStatic(root, options) {
  const baseStatic = realExpress.static(root, options);
  return function timedFaultStaticMiddleware(req, res, next) {
    if (req.path === '/app.html') {
      try {
        const appPath = path.join(root, 'app.html');
        let html = fs.readFileSync(appPath, 'utf8');
        const scriptTag = '<script src="/fault-timer-ui.js"></script>';
        if (!html.includes(scriptTag)) html = html.replace('</body>', `${scriptTag}\n</body>`);
        return res.type('html').send(html);
      } catch (err) {
        console.error('[falha-timer] Falha ao injetar UI temporizada:', err);
      }
    }
    return baseStatic(req, res, next);
  };
};

require.cache[expressPath].exports = wrappedExpress;

// server-v2 registers all existing routes and starts listening asynchronously.
require('./server-v2.js');

if (!capturedApp) {
  throw new Error('Não foi possível capturar a instância Express do backend.');
}

const app = capturedApp;

function writeTimerState() {
  try {
    fs.mkdirSync(path.dirname(TIMER_STATE_PATH), { recursive: true });
    if (!autoOffAt) {
      if (fs.existsSync(TIMER_STATE_PATH)) fs.unlinkSync(TIMER_STATE_PATH);
      return;
    }
    const tmp = `${TIMER_STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      auto_off_at: autoOffAt.toISOString(),
      tipo_falha: timedFaultType
    }), 'utf8');
    fs.renameSync(tmp, TIMER_STATE_PATH);
  } catch (err) {
    console.error('[falha-timer] Falha ao persistir estado do temporizador:', err);
  }
}

function readTimerState() {
  try {
    if (!fs.existsSync(TIMER_STATE_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(TIMER_STATE_PATH, 'utf8'));
    const parsed = new Date(data.auto_off_at);
    if (Number.isNaN(parsed.getTime())) return null;
    return {
      autoOffAt: parsed,
      tipoFalha: normalizeFaultType(data.tipo_falha)
    };
  } catch (err) {
    console.error('[falha-timer] Estado persistido inválido:', err);
    return null;
  }
}

async function setFaultFlag(value, attempts = 1, tipoFalha = null) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const body = { falha: value ? 1 : 0 };
      if (value) body.tipo_falha = normalizeFaultType(tipoFalha);
      const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/falha`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError || new Error('Falha ao atualizar flag de falha.');
}

function cancelScheduledAutoOff({ removePersistence = true } = {}) {
  if (autoOffTimer) clearTimeout(autoOffTimer);
  autoOffTimer = null;
  autoOffAt = null;
  timedFaultType = null;
  if (removePersistence) writeTimerState();
}

async function expireTimedFault() {
  if (expiryInProgress) return;
  expiryInProgress = true;
  try {
    await setFaultFlag(false, 5);
    cancelScheduledAutoOff();
    console.log('[falha-timer] Falha temporária encerrada automaticamente.');
  } catch (err) {
    console.error('[falha-timer] Não foi possível desativar a falha; nova tentativa em 1 s:', err);
    autoOffTimer = setTimeout(expireTimedFault, 1000);
  } finally {
    expiryInProgress = false;
  }
}

function scheduleAutoOff(targetDate, tipoFalha = timedFaultType) {
  if (autoOffTimer) clearTimeout(autoOffTimer);
  autoOffAt = new Date(targetDate);
  timedFaultType = normalizeFaultType(tipoFalha);
  writeTimerState();
  const delay = autoOffAt.getTime() - Date.now();
  if (delay <= 0) {
    autoOffTimer = setTimeout(expireTimedFault, 0);
    return;
  }
  autoOffTimer = setTimeout(expireTimedFault, delay);
}

function timerStatus() {
  const remainingMs = autoOffAt ? Math.max(0, autoOffAt.getTime() - Date.now()) : 0;
  return {
    active: Boolean(autoOffAt && remainingMs > 0),
    auto_off_at: autoOffAt ? autoOffAt.toISOString() : null,
    remaining_seconds: autoOffAt ? Math.max(0, Math.ceil(remainingMs / 1000)) : 0,
    max_seconds: MAX_TIMED_FAULT_SECONDS,
    tipo_falha: autoOffAt ? timedFaultType : null
  };
}

app.get('/api/falha/timed', (req, res) => {
  res.json(timerStatus());
});

app.post('/api/falha/timed', async (req, res) => {
  const seconds = Number(req.body?.seconds);
  const tipoFalha = normalizeFaultType(req.body?.tipo_falha);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMED_FAULT_SECONDS) {
    return res.status(400).json({
      error: `seconds deve ser um inteiro entre 1 e ${MAX_TIMED_FAULT_SECONDS}.`
    });
  }

  try {
    await setFaultFlag(true, 3, tipoFalha);
    scheduleAutoOff(new Date(Date.now() + seconds * 1000), tipoFalha);
    console.log(
      `[falha-timer] Falha ativada por ${seconds} s` +
      `${tipoFalha ? ` (${tipoFalha})` : ''}; desligamento em ${autoOffAt.toISOString()}.`
    );
    return res.json({ ok: true, falha: 1, ...timerStatus() });
  } catch (err) {
    console.error('[falha-timer] Erro ao ativar falha temporária:', err);
    return res.status(503).json({ error: 'Não foi possível ativar a falha temporária.' });
  }
});

app.post('/api/falha/timed/cancel', (req, res) => {
  cancelScheduledAutoOff();
  res.json({ ok: true, ...timerStatus() });
});

async function restoreTimedFault() {
  const persisted = readTimerState();
  if (!persisted) return;
  autoOffAt = persisted.autoOffAt;
  timedFaultType = persisted.tipoFalha;

  try {
    if (autoOffAt.getTime() <= Date.now()) {
      await setFaultFlag(false, 20);
      cancelScheduledAutoOff();
      console.log('[falha-timer] Temporizador expirou durante reinício; falha normalizada para OFF.');
      return;
    }

    await setFaultFlag(true, 20, timedFaultType);
    scheduleAutoOff(autoOffAt, timedFaultType);
    console.log(
      `[falha-timer] Temporizador restaurado até ${autoOffAt.toISOString()}` +
      `${timedFaultType ? ` (${timedFaultType})` : ''}.`
    );
  } catch (err) {
    console.error('[falha-timer] Falha ao restaurar temporizador persistido:', err);
  }
}

// Initialize DB metadata eagerly, then restore any persisted timed fault.
setTimeout(() => {
  ensureFaultMetadataDb()
    .then(() => restoreTimedFault())
    .catch((err) => console.error('[falha-tipo] Erro na inicialização/restauração:', err));
}, 500);
