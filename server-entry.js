// server-entry.js
// Adds backend-managed timed fault injection without coupling the timer to the browser.
// The existing server-v2.js remains the source of truth for the PV backend.

const fs = require('fs');
const path = require('path');

const expressPath = require.resolve('express');
const realExpress = require(expressPath);
let capturedApp = null;

function wrappedExpress(...args) {
  const app = realExpress(...args);
  capturedApp = app;
  return app;
}
Object.assign(wrappedExpress, realExpress);

// Injeta a UI da falha temporária sem duplicar ou reescrever o dashboard principal.
// O middleware estático original continua servindo todos os demais arquivos normalmente.
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
const TIMER_STATE_PATH = process.env.FALHA_TIMER_STATE_PATH || '/data/falha-timer.json';
const SERVER_PORT = Number(process.env.PORT || 4000);
const MAX_TIMED_FAULT_SECONDS = 7 * 24 * 60 * 60; // 7 dias

let autoOffAt = null;
let autoOffTimer = null;
let expiryInProgress = false;

function writeTimerState() {
  try {
    fs.mkdirSync(path.dirname(TIMER_STATE_PATH), { recursive: true });
    if (!autoOffAt) {
      if (fs.existsSync(TIMER_STATE_PATH)) fs.unlinkSync(TIMER_STATE_PATH);
      return;
    }
    const tmp = `${TIMER_STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ auto_off_at: autoOffAt.toISOString() }), 'utf8');
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
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch (err) {
    console.error('[falha-timer] Estado persistido inválido:', err);
    return null;
  }
}

async function setFaultFlag(value, attempts = 1) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/falha`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ falha: value ? 1 : 0 })
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

function scheduleAutoOff(targetDate) {
  if (autoOffTimer) clearTimeout(autoOffTimer);
  autoOffAt = new Date(targetDate);
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
    max_seconds: MAX_TIMED_FAULT_SECONDS
  };
}

app.get('/api/falha/timed', (req, res) => {
  res.json(timerStatus());
});

app.post('/api/falha/timed', async (req, res) => {
  const seconds = Number(req.body?.seconds);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMED_FAULT_SECONDS) {
    return res.status(400).json({
      error: `seconds deve ser um inteiro entre 1 e ${MAX_TIMED_FAULT_SECONDS}.`
    });
  }

  try {
    // Ativa primeiro; só agenda o desligamento se o backend confirmou a mudança.
    await setFaultFlag(true, 3);
    scheduleAutoOff(new Date(Date.now() + seconds * 1000));
    console.log(`[falha-timer] Falha ativada por ${seconds} s; desligamento em ${autoOffAt.toISOString()}.`);
    return res.json({ ok: true, falha: 1, ...timerStatus() });
  } catch (err) {
    console.error('[falha-timer] Erro ao ativar falha temporária:', err);
    return res.status(503).json({ error: 'Não foi possível ativar a falha temporária.' });
  }
});

app.post('/api/falha/timed/cancel', (req, res) => {
  // Cancela somente o desligamento automático. O chamador decide o estado final da flag.
  cancelScheduledAutoOff();
  res.json({ ok: true, ...timerStatus() });
});

async function restoreTimedFault() {
  const persisted = readTimerState();
  if (!persisted) return;
  autoOffAt = persisted;

  try {
    if (autoOffAt.getTime() <= Date.now()) {
      // Se o processo ficou fora durante o prazo, não deixe a falha presa em ON.
      await setFaultFlag(false, 20);
      cancelScheduledAutoOff();
      console.log('[falha-timer] Temporizador expirou durante reinício; falha normalizada para OFF.');
      return;
    }

    await setFaultFlag(true, 20);
    scheduleAutoOff(autoOffAt);
    console.log(`[falha-timer] Temporizador restaurado até ${autoOffAt.toISOString()}.`);
  } catch (err) {
    console.error('[falha-timer] Falha ao restaurar temporizador persistido:', err);
  }
}

// Dá tempo para server-v2 concluir initDb() e app.listen(). setFaultFlag possui retries adicionais.
setTimeout(() => {
  restoreTimedFault().catch((err) => console.error('[falha-timer] Erro na restauração:', err));
}, 500);
