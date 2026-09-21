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

  function renderCountdown() {
    if (!autoOffAtMs) {
      status.textContent = '';
      return;
    }
    const remaining = Math.max(0, Math.ceil((autoOffAtMs - Date.now()) / 1000));
    if (remaining > 0) {
      status.textContent = `Falha temporária ativa — ${remaining}s restantes`;
      return;
    }

    status.textContent = 'Encerrando falha temporária…';
    autoOffAtMs = null;
    if (!expiryRefreshPending) {
      expiryRefreshPending = true;
      setTimeout(async () => {
        try {
          const res = await fetch('/api/falha');
          if (res.ok) falhaToggle.checked = (await res.json()).falha === 1;
        } catch (err) {
          console.error('Erro ao atualizar estado da falha após temporizador:', err);
        } finally {
          expiryRefreshPending = false;
          status.textContent = '';
        }
      }, 300);
    }
  }

  async function refreshTimerStatus() {
    try {
      const res = await fetch('/api/falha/timed');
      if (!res.ok) return;
      const data = await res.json();
      autoOffAtMs = data.active && data.auto_off_at ? Date.parse(data.auto_off_at) : null;
      if (data.active) falhaToggle.checked = true;
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
    renderCountdown();
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
        const res = await fetch('/api/falha');
        if (res.ok) falhaToggle.checked = (await res.json()).falha === 1;
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
