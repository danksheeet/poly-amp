// Выбор тона на TONE3000 (только в приложении). Сам каталог и вход в аккаунт показывает
// TONE3000 в отдельном окне; здесь — карточка выбранного тона, выбор модели и ход загрузки.
// Все строки с сервера вставляются как текст, не как разметка.

const GEAR = {
  amp: 'amp',
  'amp-cab': 'amp + cab',
  'full-rig': 'amp + cab',
  pedal: 'pedal',
  outboard: 'studio gear',
  cab: 'cab',
  space: 'space',
  experimental: 'experimental',
};
const ARCH = { 1: 'A1', 2: 'A2', custom: 'Custom' };
const LOAD_LABEL = { pedal: 'Add pedal', amp: 'Add amp', cab: 'Add cab', space: 'Add to chain' };

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const safeImage = (url) => (typeof url === 'string' && url.startsWith('https://') ? url : null);

export function createTone3000(root, { engine }) {
  root.innerHTML = `
    <div class="modal-backdrop" data-ref="backdrop" hidden>
      <div class="modal t3k-modal" role="dialog" aria-modal="true" aria-labelledby="t3kTitle">
        <header>
          <h2 id="t3kTitle"><span class="t3k-mark">TONE3000</span></h2>
          <button class="btn btn-ghost btn-sq" data-ref="close" aria-label="Close">×</button>
        </header>
        <div class="t3k-body" data-ref="body"></div>
      </div>
    </div>`;
  const ref = {};
  for (const n of root.querySelectorAll('[data-ref]')) ref[n.dataset.ref] = n;

  // что сделать, когда пользователь введёт ключ приложения: снова открыть каталог или продолжить скачивание тонов пресета
  let resume = null;
  let waitingKey = false;

  const show = () => (ref.backdrop.hidden = false);
  const hide = () => (ref.backdrop.hidden = true);
  ref.close.addEventListener('click', hide);
  ref.backdrop.addEventListener('pointerdown', (e) => e.target === ref.backdrop && hide());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !ref.backdrop.hidden && hide());

  function message(text, kind = '') {
    ref.body.replaceChildren(el('p', 't3k-message ' + kind, text));
    show();
  }

  function renderKeyForm() {
    const p = el('p', 't3k-message',
      'To pick tones right from here, you need an app key (publishable key) from your account settings on tone3000.com.');
    const row = el('div', 't3k-keyrow');
    const input = el('input', 'text-input');
    input.placeholder = 't3k_pub_…';
    input.spellcheck = false;
    const save = el('button', 'btn btn-primary', 'Save');
    save.addEventListener('click', () => {
      const key = input.value.trim();
      if (!key) return input.focus();
      waitingKey = true;
      engine.t3kSetKey(key);
    });
    row.append(input, save);
    ref.body.replaceChildren(p, row);
    show();
    input.focus();
  }

  function renderTone(m) {
    const t = m.tone;
    const head = el('div', 't3k-tone');
    const cover = safeImage(t.Image);
    if (cover) {
      const img = el('img', 't3k-cover');
      img.src = cover;
      img.alt = '';
      head.append(img);
    }
    const info = el('div', 't3k-info');
    info.append(el('h3', '', t.Title || 'Untitled'));
    const creator = el('div', 't3k-creator');
    const avatar = safeImage(t.Avatar);
    if (avatar) {
      const a = el('img');
      a.src = avatar;
      a.alt = '';
      creator.append(a);
    }
    creator.append(el('span', '', t.Creator || 'unknown creator'));
    info.append(creator);
    const tags = el('div', 't3k-tags');
    for (const text of [GEAR[t.Gear] || t.Gear, (t.Format || '').toUpperCase(), t.License && `license ${t.License}`]) {
      if (text) tags.append(el('span', 't3k-tag', text));
    }
    info.append(tags);
    head.append(info);

    const nodes = [head];
    if (t.Description) {
      const text = t.Description.length > 420 ? t.Description.slice(0, 420).trimEnd() + '…' : t.Description;
      nodes.push(el('p', 't3k-desc', text));
    }

    const models = m.models || [];
    let selected = (models.find((x) => String(x.Architecture) === '2') || models[0] || {}).Id;
    const list = el('div', 't3k-models');
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', 'Model');
    const rows = [];
    for (const model of models) {
      const row = el('button', 't3k-model');
      row.setAttribute('role', 'radio');
      row.append(el('span', 't3k-model-name', model.Name || `Model ${model.Id}`));
      const meta = [model.Size, ARCH[model.Architecture]].filter(Boolean).join(' · ');
      if (meta) row.append(el('span', 't3k-model-meta', meta));
      row.addEventListener('click', () => {
        selected = model.Id;
        sync();
      });
      row.addEventListener('dblclick', () => load.click());
      rows.push([model.Id, row]);
      list.append(row);
    }
    const sync = () => rows.forEach(([id, row]) => row.setAttribute('aria-checked', id === selected));

    const actions = el('div', 't3k-actions');
    const page = el('button', 'btn btn-ghost', 'Tone page on TONE3000 ↗');
    page.addEventListener('click', () => engine.openUrl(t.Url));
    page.hidden = !t.Url;
    const load = el('button', 'btn btn-primary', LOAD_LABEL[m.kind] || 'Load');
    load.addEventListener('click', () => {
      if (selected == null) return;
      load.disabled = true;
      engine.t3kDownload(selected);
    });
    actions.append(page, load);

    if (models.length) {
      nodes.push(el('div', 't3k-label', models.length > 1 ? `Models of this tone — ${models.length}` : 'Model'), list);
    } else {
      nodes.push(el('p', 't3k-message bad', 'This tone has no files in a supported format.'));
      load.hidden = true;
    }
    nodes.push(actions);
    ref.body.replaceChildren(...nodes);
    sync();
    show();
    load.focus();
  }

  function onMessage(m) {
    switch (m.stage) {
      case 'status':
        if (waitingKey && m.hasKey) {
          waitingKey = false;
          hide();
          const next = resume;
          resume = null;
          next?.();
        }
        break;
      case 'needKey':
        renderKeyForm();
        break;
      case 'loading':
        message('Getting the tone and its models…');
        break;
      case 'tone':
        renderTone(m);
        break;
      case 'downloading':
        message('Downloading and loading…');
        break;
      case 'done':
        hide();
        break;
      case 'error':
        message(m.error || 'Something went wrong.'
, 'bad');
        break;
    }
  }

  if (engine.isNative) engine.on('t3k', onMessage);

  return {
    /**
     * Открыть каталог TONE3000 для блока цепочки.
     * @param {'pedal'|'amp'|'cab'|'space'} kind педали, усилители, импульсы кабинетов или пространства
     * @param {'1'|'2'} catalog для моделей: A2 или прежние A1
     * @param {string|null} blockId куда поставить выбранный тон
     */
    open(kind, catalog = '2', blockId = null) {
      resume = () => engine.t3kSelect(kind, catalog, blockId);
      engine.t3kSelect(kind, catalog, blockId);
    },
    /** Что продолжить после ввода ключа (скачивание тонов пресета). */
    setResume(fn) {
      resume = fn;
    },
    /** Для проверки вёрстки без приложения: подставить сообщение движка. */
    preview: onMessage,
  };
}
