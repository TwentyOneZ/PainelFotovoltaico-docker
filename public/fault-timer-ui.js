(() => {
  const $ = (id) => document.getElementById(id);
  const falhaToggle = $('falhaToggle');
  const grid = document.querySelector('.card .grid');
  if (!falhaToggle || !grid) return;

  const block = document.createElement('div');
  block.innerHTML = `
    <label for="falhaDuration">Falha temporária (s)</label>
    <div class="actions" style="height:42px;align-items:center">
      <input type="number" id="falhaDuration" min="1" max="604800" step="1" value="60" style="width:120px" />
      <button id="falhaTimedOk" type="button">OK</button>
    </div>
    <div id="falhaTimedStatus" class="hint" style="min-height:16px;margin-top:6px"></div>
  `;
  grid.appendChild(block);

  const durationInput = $('falhaDuration');
  const okButton = $('falhaTimedOk');
  const status = $('falhaTimedStatus');

  let autoOffAtMs = null;
  let expiryRefreshPending = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function fetchTimerStatus() {
    const res = await fetch('/api/falha/timed', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function fetchFaultState() {
    const res = await fetch('/api/falha', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // O backend só marca o temporizador como inativo depois que o POST interno
  // de falha=0 foi confirmado. Portanto /api/falha/timed é a fonte autoritativa
  // para o encerramento de uma falha temporizada. Isso evita depender do último
  // registro já persistido no MySQL, que pode estar até alguns segundos atrasado
  // devido ao batch insert de 5 s.
  async function syncAfterTimedExpiry() {
    if (expiryRefreshPending) return;
    expiryRefreshPending = true;
    status.textContent = 'Encerrando falha temporária…';

    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          const timer = await fetchTimerStatus();
          if (timer.active && timer.auto_off_at) {
            // O relógio do navegador pode ter chegado a zero antes do backend.
            autoOffAtMs = Date.parse(timer.auto_off_at);
            renderCountdown();
            return;
          }

          // timer.active=false só é publicado pelo backend depois de desativar
          // a flag com sucesso. Atualize a UI imediatamente, sem aguardar o lote
          // seguinte ser persistido no MySQL.
          autoOffAtMs = null;
          falhaToggle.checked = false;
          status.textContent = '';
          return;
        } catch (err) {
          if (attempt === 19) throw err;
        }
        await sleep(500);
      }
    } catch (err) {
      console.error('Erro ao confirmar expiração da falha temporária:', err);
      status.textContent = 'Temporizador expirou; aguardando sincronização…';

      // Fallback: tenta refletir o endpoint legado. Ele pode ficar brevemente
      // atrasado enquanto o batch do MySQL ainda não foi gravado.
      try {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const data = await fetchFaultState();
          const active = data.falha === 1;
          falhaToggle.checked = active;
          if (!active) {
            status.textContent = '';
            return;
          }
          await sleep(500);
        }
      } catch (fallbackErr) {
        console.error('Erro ao sincronizar estado da falha:', fallbackErr);
      }
    } finally {
      expiryRefreshPending = false;
    }
  }

  function renderCountdown() {
    if (!autoOffAtMs) {
      if (!expiryRefreshPending) status.textContent = '';
      return;
    }

    const remaining = Math.max(0, Math.ceil((autoOffAtMs - Date.now()) / 1000));
    if (remaining > 0) {
      status.textContent = `Falha temporária ativa — ${remaining}s restantes`;
      return;
    }

    // Não altera apenas visualmente e depois consulta /api/falha uma única vez.
    // Esse era o race condition: /api/falha lê o último heartbeat persistido e
    // podia devolver falha=1 durante a janela de até 5 s do batch insert.
    syncAfterTimedExpiry();
  }

  async function refreshTimerStatus() {
    try {
      const data = await fetchTimerStatus();
      autoOffAtMs = data.active && data.auto_off_at ? Date.parse(data.auto_off_at) : null;
      if (data.active) {
        falhaToggle.checked = true;
      } else {
        // Quando não há timer ativo, use o estado normal da flag.
        try {
          const fault = await fetchFaultState();
          falhaToggle.checked = fault.falha === 1;
        } catch (err) {
          console.error('Erro ao consultar estado normal da falha:', err);
        }
      }
      renderCountdown();
    } catch (err) {
      console.error('Erro ao consultar temporizador da falha:', err);
    }
  }

  async function cancelTimedFaultSchedule() {
    try {
      await fetch('/api/falha/timed/cancel', { method: 'POST' });
    } catch (err) {
      console.error('Erro ao cancelar temporizador da falha:', err);
    }
    autoOffAtMs = null;
    status.textContent = '';
  }

  // Intercepta o toggle manual antes do listener legado para que uma alteração
  // manual cancele qualquer desligamento automático pendente.
  falhaToggle.addEventListener('change', async (event) => {
    event.stopImmediatePropagation();
    const desired = event.target.checked ? 1 : 0;
    await cancelTimedFaultSchedule();
    try {
      const res = await fetch('/api/falha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ falha: desired })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.error('Erro ao atualizar falha manualmente:', err);
      try {
        const data = await fetchFaultState();
        falhaToggle.checked = data.falha === 1;
      } catch {}
    }
  }, true);

  async function activateTimedFault() {
    const seconds = Number(durationInput.value);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 604800) {
      status.textContent = 'Informe um tempo inteiro entre 1 e 604800 segundos.';
      durationInput.focus();
      return;
    }

    okButton.disabled = true;
    status.textContent = 'Ativando falha temporária…';
    try {
      const res = await fetch('/api/falha/timed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      falhaToggle.checked = true;
      autoOffAtMs = data.auto_off_at ? Date.parse(data.auto_off_at) : Date.now() + seconds * 1000;
      renderCountdown();
    } catch (err) {
      status.textContent = `Erro: ${err.message}`;
    } finally {
      okButton.disabled = false;
    }
  }

  okButton.addEventListener('click', activateTimedFault);
  durationInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') activateTimedFault();
  });

  setInterval(renderCountdown, 1000);
  refreshTimerStatus();
})();
