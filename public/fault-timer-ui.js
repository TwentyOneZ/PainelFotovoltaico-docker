(() => {
  const $ = (id) => document.getElementById(id);
  const falhaToggle = $('falhaToggle');
  const grid = document.querySelector('.card .grid');
  if (!falhaToggle || !grid) return;

  const typeBlock = document.createElement('div');
  typeBlock.innerHTML = `
    <label for="falhaTipo">Tipo da falha</label>
    <div class="actions" style="height:42px;align-items:center">
      <input
        type="text"
        id="falhaTipo"
        maxlength="255"
        placeholder="Ex.: curto-circuito na carga"
        autocomplete="off"
      />
    </div>
  `;
  grid.appendChild(typeBlock);

  const timerBlock = document.createElement('div');
  timerBlock.innerHTML = `
    <label for="falhaDuration">Falha temporária (s)</label>
    <div class="actions" style="height:42px;align-items:center">
      <input type="number" id="falhaDuration" min="1" max="604800" step="1" value="60" style="width:120px" />
      <button id="falhaTimedOk" type="button">OK</button>
    </div>
    <div id="falhaTimedStatus" class="hint" style="min-height:16px;margin-top:6px"></div>
  `;
  grid.appendChild(timerBlock);

  const typeInput = $('falhaTipo');
  const durationInput = $('falhaDuration');
  const okButton = $('falhaTimedOk');
  const status = $('falhaTimedStatus');

  let autoOffAtMs = null;
  let activeFaultType = null;
  let expiryRefreshPending = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalizedType = () => {
    const text = String(typeInput.value || '').trim();
    return text ? text.slice(0, 255) : null;
  };

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

  function renderCountdown() {
    if (!autoOffAtMs) {
      if (!expiryRefreshPending) status.textContent = '';
      return;
    }

    const remaining = Math.max(0, Math.ceil((autoOffAtMs - Date.now()) / 1000));
    if (remaining > 0) {
      status.textContent = `Falha temporária ativa — ${remaining}s restantes${activeFaultType ? ` — ${activeFaultType}` : ''}`;
      return;
    }

    syncAfterTimedExpiry();
  }

  async function syncAfterTimedExpiry() {
    if (expiryRefreshPending) return;
    expiryRefreshPending = true;
    status.textContent = 'Encerrando falha temporária…';

    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          const timer = await fetchTimerStatus();
          if (timer.active && timer.auto_off_at) {
            autoOffAtMs = Date.parse(timer.auto_off_at);
            activeFaultType = timer.tipo_falha || activeFaultType;
            if (timer.tipo_falha) typeInput.value = timer.tipo_falha;
            renderCountdown();
            return;
          }

          autoOffAtMs = null;
          activeFaultType = null;
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

      try {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const data = await fetchFaultState();
          const active = data.falha === 1;
          falhaToggle.checked = active;
          if (active && data.tipo_falha) {
            activeFaultType = data.tipo_falha;
            typeInput.value = data.tipo_falha;
          }
          if (!active) {
            activeFaultType = null;
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

  async function refreshTimerStatus() {
    try {
      const data = await fetchTimerStatus();
      autoOffAtMs = data.active && data.auto_off_at ? Date.parse(data.auto_off_at) : null;
      activeFaultType = data.active ? (data.tipo_falha || null) : null;

      if (data.active) {
        falhaToggle.checked = true;
        if (data.tipo_falha) typeInput.value = data.tipo_falha;
      } else {
        try {
          const fault = await fetchFaultState();
          falhaToggle.checked = fault.falha === 1;
          activeFaultType = fault.falha === 1 ? (fault.tipo_falha || null) : null;
          if (fault.falha === 1 && fault.tipo_falha) typeInput.value = fault.tipo_falha;
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
    activeFaultType = null;
    status.textContent = '';
  }

  // Intercept the legacy toggle. When turning ON, the current text in
  // "Tipo da falha" is sent together with the flag. When turning OFF the backend
  // closes the fault interval, and subsequent 1 Hz rows store tipo_falha = NULL.
  falhaToggle.addEventListener('change', async (event) => {
    event.stopImmediatePropagation();
    const desired = event.target.checked ? 1 : 0;
    const tipoFalha = desired ? normalizedType() : null;
    await cancelTimedFaultSchedule();

    try {
      const payload = { falha: desired };
      if (desired) payload.tipo_falha = tipoFalha;
      const res = await fetch('/api/falha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      activeFaultType = desired ? (data.tipo_falha || tipoFalha) : null;
      if (desired && activeFaultType) typeInput.value = activeFaultType;
    } catch (err) {
      console.error('Erro ao atualizar falha manualmente:', err);
      try {
        const data = await fetchFaultState();
        falhaToggle.checked = data.falha === 1;
        activeFaultType = data.falha === 1 ? (data.tipo_falha || null) : null;
        if (activeFaultType) typeInput.value = activeFaultType;
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

    const tipoFalha = normalizedType();
    okButton.disabled = true;
    status.textContent = 'Ativando falha temporária…';

    try {
      const res = await fetch('/api/falha/timed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds, tipo_falha: tipoFalha })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      falhaToggle.checked = true;
      activeFaultType = data.tipo_falha || tipoFalha;
      if (activeFaultType) typeInput.value = activeFaultType;
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
