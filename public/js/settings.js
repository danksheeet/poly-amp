// Окно «Настройки звука» (только в приложении): драйвер, вход, выход, частота, буфер, задержка.

const ms = (v) => v.toFixed(1) + ' ms';

export function createSettings(root, { engine, store }) {
  root.innerHTML = `
    <div class="modal-backdrop" data-ref="backdrop" hidden>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
        <header>
          <h2 id="settingsTitle">Audio settings</h2>
          <button class="btn btn-ghost btn-sq" data-ref="close" aria-label="Close">×</button>
        </header>
        <div class="form">
          <label for="setDriver">Driver</label>
          <select class="select" id="setDriver" data-ref="driver"></select>
          <label for="setIn">Input (guitar)</label>
          <select class="select" id="setIn" data-ref="input"></select>
          <label for="setOut">Output</label>
          <select class="select" id="setOut" data-ref="output"></select>
          <label for="setRate">Sample rate</label>
          <select class="select" id="setRate" data-ref="rate"></select>
          <span class="form-label">Buffer</span>
          <div class="form-row"><b data-ref="buffer">—</b><button class="btn" data-ref="panel">Driver panel…</button></div>
          <span class="form-label">Latency</span>
          <div class="form-row"><b data-ref="latency">—</b></div>
        </div>
        <div class="notice notice-error" data-ref="error" hidden></div>
        <div class="notice" data-ref="noDrivers" hidden>
          <div><strong>No ASIO driver found.</strong> Install the ASIO driver of your audio interface (from its maker’s site).
            For a built-in sound card or a USB headset, a free universal driver works:
            <a href="#" data-link="https://asio4all.org/">ASIO4ALL</a> or <a href="#" data-link="https://github.com/dechamps/FlexASIO">FlexASIO</a>.
            Then restart Poly Amp.</div>
        </div>
        <p class="hint">The buffer size is set in the driver panel. At 64–128 samples latency is unnoticeable; if the sound crackles, increase the buffer.
          Turn off Direct Monitor on the interface itself, otherwise the dry signal will be heard over the processed one.</p>
      </div>
    </div>`;

  const ref = {};
  for (const n of root.querySelectorAll('[data-ref]')) ref[n.dataset.ref] = n;

  let cfg = store.get('audio', null);
  let started = false;

  function options(select, items, value) {
    select.replaceChildren(
      ...items.map(([v, text]) => {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = text;
        return o;
      })
    );
    select.value = value;
  }

  function render() {
    const a = engine.audio;
    const drivers = engine.drivers;
    options(ref.driver, [['', '— audio off —'], ...drivers.map((d) => [d, d])], cfg?.driver && drivers.includes(cfg.driver) ? cfg.driver : '');

    const open = a.open;
    options(ref.input, open ? a.inputs.map((n, i) => [i, n]) : [], open ? a.inCh : '');
    const pairs = [];
    if (open) {
      for (let i = 0; i < a.outputs.length; i += 2) {
        pairs.push([i, a.outputs[i + 1] ? `${a.outputs[i]} + ${a.outputs[i + 1]}` : a.outputs[i]]);
      }
    }
    options(ref.output, pairs, open ? a.outCh - (a.outCh % 2) : '');
    options(ref.rate, open ? a.rates.map((r) => [r, (r / 1000).toString() + ' kHz']) : [], open ? a.sampleRate : '');
    for (const s of [ref.input, ref.output, ref.rate]) s.disabled = !open;
    ref.panel.disabled = !open;

    if (open) {
      ref.buffer.textContent = `${a.bufferSize} samples · ${ms((a.bufferSize / a.sampleRate) * 1000)}`;
      const li = (a.inputLatency / a.sampleRate) * 1000;
      const lo = (a.outputLatency / a.sampleRate) * 1000;
      ref.latency.textContent = `${ms(li + lo)} round trip (input ${ms(li)} + output ${ms(lo)})`;

    } else {
      ref.buffer.textContent = '—';
      ref.latency.textContent = '—';
    }
    ref.error.hidden = !a.error;
    ref.error.textContent = a.error || '';
    ref.noDrivers.hidden = drivers.length > 0;
  }
  // ссылки подсказки открываются в обычном браузере
  ref.noDrivers.addEventListener('click', (e) => {
    const a = e.target.closest('[data-link]');
    if (!a) return;
    e.preventDefault();
    engine.openUrl(a.dataset.link);
  });

  function apply() {
    store.set('audio', cfg);
    if (cfg.driver) engine.open(cfg.driver, cfg.inCh, cfg.outCh, cfg.rate);
    else engine.close();
  }

  ref.driver.addEventListener('change', () => {
    cfg = { driver: ref.driver.value, inCh: 0, outCh: 0, rate: 0 };
    apply();
  });
  ref.input.addEventListener('change', () => ((cfg.inCh = +ref.input.value), apply()));
  ref.output.addEventListener('change', () => ((cfg.outCh = +ref.output.value), apply()));
  ref.rate.addEventListener('change', () => ((cfg.rate = +ref.rate.value), apply()));
  ref.panel.addEventListener('click', () => engine.showDriverPanel());

  const api = {
    open() {
      render();
      ref.backdrop.hidden = false;
      ref.driver.focus();
    },
    close() {
      ref.backdrop.hidden = true;
    },
  };
  ref.close.addEventListener('click', api.close);
  ref.backdrop.addEventListener('pointerdown', (e) => e.target === ref.backdrop && api.close());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !ref.backdrop.hidden && api.close());

  engine.on('drivers', render);
  engine.on('state', () => {
    render();
    if (started) return;
    started = true; // первый ответ движка после запуска — решаем, что открывать
    if (engine.audio.open) return;
    if (!cfg) {
      // первый запуск: если драйвер аудиоинтерфейса один — сразу его. Универсальные (ASIO4ALL, FlexASIO и т. п.)
      // берём, только когда кроме них ничего нет; если интерфейсов несколько — пусть выберет сам.
      const generic = /asio4all|flexasio|generic low latency|asio2wasapi|voicemeeter|realtek asio/i;
      const hw = engine.drivers.filter((d) => !generic.test(d));
      const guess = hw.length === 1 ? hw[0] : !hw.length && engine.drivers.length ? engine.drivers[0] : null;
      if (guess) cfg = { driver: guess, inCh: 0, outCh: 0, rate: 0 };
    }
    if (cfg?.driver && engine.drivers.includes(cfg.driver)) apply();
    else api.open();
  });

  return api;
}
