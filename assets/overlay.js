/**
 * Review Comments overlay.
 *
 * Click "Comment", click anything on the page, write. Every comment stores
 * where it was made (selector, text snippet, block, heading, post ID and
 * viewport) so it can be found again, by people on the page and by Claude
 * through the MCP abilities.
 *
 * All UI lives in a shadow root so the theme's CSS cannot reach it.
 */
(() => {
  const C = window.wprcConfig;
  if (!C || window.wprcLoaded) return;
  window.wprcLoaded = true;

  const STATUS_LABELS = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', wontfix: "Won't fix" };
  const DONE = ['resolved', 'wontfix'];
  const POLL_MS = 20000;

  const state = {
    me: null,
    threads: [],
    commenting: false,
    panelOpen: false,
    showDone: false,
    activeId: null,
    drafts: {},
    composer: null,
  };

  // --- helpers -------------------------------------------------------------

  const store = {
    get(key) { try { return localStorage.getItem('wprc_' + key) || ''; } catch (e) { return ''; } },
    set(key, value) { try { localStorage.setItem('wprc_' + key, value); } catch (e) { /* private mode */ } },
  };

  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (C.nonce) headers['X-WP-Nonce'] = C.nonce;
    const response = await fetch(C.rest + path, { credentials: 'same-origin', ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'Request failed (' + response.status + ')');
    return data;
  }

  function pageUrl() {
    const params = new URLSearchParams(location.search);
    params.delete('review');
    const query = params.toString();
    return location.pathname + (query ? '?' + query : '');
  }

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'class') el.className = value;
      else if (key in el && key !== 'list') el[key] = value;
      else el.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      el.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function timeAgo(iso) {
    const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + ' h ago';
    return new Date(iso).toLocaleDateString();
  }

  // --- describing an element -----------------------------------------------

  const stableId = (id) => id && !/\d{3,}|^[a-f0-9-]{16,}$/i.test(id) && document.querySelectorAll('#' + CSS.escape(id)).length === 1;

  function selectorFor(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      if (stableId(node.id)) {
        parts.unshift('#' + CSS.escape(node.id));
        return parts.join(' > ');
      }
      let part = node.localName;
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((child) => child.localName === node.localName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    parts.unshift('body');
    return parts.join(' > ');
  }

  const clean = (text) => (text || '').replace(/\s+/g, ' ').trim();

  function snippetFor(el) {
    return clean(el.innerText || el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder')).slice(0, 160)
      || '<' + el.localName + '>';
  }

  function headingFor(el) {
    if (/^h[1-6]$/.test(el.localName)) return clean(el.innerText).slice(0, 120);
    let node = el;
    for (let depth = 0; node && node !== document.body && depth < 8; depth++, node = node.parentElement) {
      const heading = node.querySelector('h1, h2, h3, h4');
      if (heading) return clean(heading.innerText).slice(0, 120);
    }
    return '';
  }

  function blockFor(el) {
    const chain = [];
    for (let node = el; node && node !== document.body && chain.length < 3; node = node.parentElement) {
      const match = typeof node.className === 'string' && node.className.match(/(?:^|\s)(wp-block-[a-z0-9-]+)/);
      if (match && !chain.includes(match[1])) chain.push(match[1]);
    }
    return chain.join(' < ');
  }

  function postId() {
    const match = document.body.className.match(/(?:^|\s)(?:postid|page-id)-(\d+)/);
    return match ? Number(match[1]) : 0;
  }

  /** Find a thread's element again: selector first, then its text. */
  function findElement(thread) {
    let el = null;
    try { el = document.querySelector(thread.selector); } catch (e) { /* bad selector */ }
    if (el && visible(el)) return el;
    const needle = (thread.snippet || '').slice(0, 60);
    if (needle.length < 8 || needle.startsWith('<')) return el;
    let best = null;
    for (const candidate of document.body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,a,button,li,span,td,th,label,figcaption,div')) {
      if (host.contains(candidate) || !visible(candidate)) continue;
      if (clean(candidate.innerText).startsWith(needle) && (!best || best.contains(candidate))) best = candidate;
    }
    return best || el;
  }

  function visible(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // --- UI ------------------------------------------------------------------

  const host = h('div', { id: 'wprc-root' });
  host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483000;';
  const root = host.attachShadow({ mode: 'open' });
  root.append(h('style', {}, CSS_TEXT()));
  const pinLayer = h('div', { class: 'pins' });
  const highlight = h('div', { class: 'highlight', hidden: true });
  const toolbar = h('div', { class: 'toolbar' });
  const panel = h('aside', { class: 'panel', hidden: true });
  const composerEl = h('div', { class: 'composer', hidden: true });
  const toast = h('div', { class: 'toast', hidden: true });
  root.append(pinLayer, highlight, toolbar, panel, composerEl, toast);

  function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.hidden = true; }, 5000);
  }

  function renderToolbar() {
    const open = state.threads.filter((t) => !DONE.includes(t.status)).length;
    toolbar.replaceChildren(
      h('button', {
        class: 'primary' + (state.commenting ? ' active' : ''),
        title: 'Click anything on the page to comment on it (Esc to cancel)',
        onclick: () => setCommenting(!state.commenting),
      }, state.commenting ? 'Cancel' : '+ Comment'),
      h('button', { onclick: () => togglePanel() }, 'Threads', h('span', { class: 'count' }, String(open))),
    );
  }

  function setCommenting(on) {
    state.commenting = on;
    document.documentElement.classList.toggle('wprc-commenting', on);
    if (!on) highlight.hidden = true;
    renderToolbar();
  }

  function togglePanel(open = !state.panelOpen) {
    state.panelOpen = open;
    panel.hidden = !open;
    if (open) renderPanel();
  }

  function numbered() {
    return [...state.threads].sort((a, b) => a.created.localeCompare(b.created)).map((t, i) => ({ ...t, n: i + 1 }));
  }

  function renderPins() {
    const items = numbered().filter((t) => state.showDone || !DONE.includes(t.status) || t.id === state.activeId);
    pinLayer.replaceChildren(...items.map((thread) => {
      const pin = h('button', {
        class: 'pin status-' + thread.status + (thread.id === state.activeId ? ' active' : ''),
        title: thread.author + ': ' + thread.text.slice(0, 80),
        onclick: () => focusThread(thread.id),
      }, String(thread.n));
      pin.dataset.id = thread.id;
      return pin;
    }));
    positionPins();
  }

  function positionPins() {
    for (const pin of pinLayer.children) {
      const thread = state.threads.find((t) => t.id === Number(pin.dataset.id));
      const el = thread && findElementCached(thread);
      if (!el || !visible(el)) { pin.hidden = true; continue; }
      const rect = el.getBoundingClientRect();
      pin.hidden = false;
      pin.style.left = rect.left + rect.width * (thread.offset_x || 0) + 'px';
      pin.style.top = rect.top + rect.height * (thread.offset_y || 0) + 'px';
    }
    if (state.activeId && !highlight.hidden && !state.commenting) {
      const thread = state.threads.find((t) => t.id === state.activeId);
      const el = thread && findElementCached(thread);
      if (el) placeHighlight(el);
    }
  }

  const elementCache = new Map();
  function findElementCached(thread) {
    const cached = elementCache.get(thread.id);
    if (cached && cached.isConnected) return cached;
    const el = findElement(thread);
    if (el) elementCache.set(thread.id, el);
    return el;
  }

  function placeHighlight(el) {
    const rect = el.getBoundingClientRect();
    Object.assign(highlight.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' });
    highlight.hidden = false;
  }

  function renderPanel() {
    if (!state.panelOpen) return;
    // Do not wipe what someone is typing; the next poll catches up.
    if (root.activeElement && panel.contains(root.activeElement) && root.activeElement.tagName === 'TEXTAREA') return;

    const items = numbered().filter((t) => state.showDone || !DONE.includes(t.status)).reverse();
    panel.replaceChildren(
      h('header', {},
        h('strong', {}, 'Review comments'),
        h('label', { class: 'toggle' },
          h('input', { type: 'checkbox', checked: state.showDone, onchange: (e) => { state.showDone = e.target.checked; renderPins(); renderPanel(); } }),
          ' Show resolved'),
        h('button', { class: 'close', title: 'Close', onclick: () => togglePanel(false) }, '×'),
      ),
      h('p', { class: 'who' }, state.me.name ? 'Commenting as ' + state.me.name : (store.get('name') ? 'Commenting as ' + store.get('name') : 'Guest reviewer'),
        state.me.round ? ' · ' + state.me.round : ''),
      items.length ? h('div', { class: 'threads' }, items.map(renderThread)) : h('p', { class: 'empty' }, 'No comments on this page yet. Click “+ Comment” and then the part of the page you want to comment on.'),
    );
  }

  function renderThread(thread) {
    const found = !!findElementCached(thread);
    return h('article', { class: 'thread' + (thread.id === state.activeId ? ' active' : '') },
      h('div', { class: 'meta', onclick: () => focusThread(thread.id) },
        h('span', { class: 'num status-' + thread.status }, String(thread.n)),
        h('strong', {}, thread.author),
        h('span', { class: 'time' }, timeAgo(thread.created)),
        state.me.is_editor
          ? h('select', { class: 'status', onclick: (e) => e.stopPropagation(), onchange: (e) => setStatus(thread.id, e.target.value) },
            Object.entries(STATUS_LABELS).map(([value, label]) => h('option', { value, selected: value === thread.status }, label)))
          : h('span', { class: 'badge status-' + thread.status }, STATUS_LABELS[thread.status]),
      ),
      h('p', { class: 'text' }, thread.text),
      found ? null : h('p', { class: 'detached' }, 'Element not found on this screen size. It was: “' + thread.snippet + '”'),
      thread.replies.map((reply) => h('div', { class: 'reply' + (reply.author_type === 'ai' ? ' ai' : '') },
        h('div', { class: 'meta' }, h('strong', {}, reply.author), h('span', { class: 'time' }, timeAgo(reply.created))),
        h('p', { class: 'text' }, reply.text),
      )),
      h('form', { class: 'reply-form', onsubmit: (e) => { e.preventDefault(); sendReply(thread.id, e.target); } },
        h('textarea', {
          rows: 1, placeholder: 'Reply…', value: state.drafts[thread.id] || '',
          oninput: (e) => { state.drafts[thread.id] = e.target.value; },
          onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.target.form.requestSubmit(); },
        }),
        h('button', { type: 'submit' }, 'Send'),
      ),
    );
  }

  function focusThread(id) {
    state.activeId = id;
    const thread = state.threads.find((t) => t.id === id);
    togglePanel(true);
    renderPins();
    const el = thread && findElementCached(thread);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      placeHighlight(el);
      setTimeout(positionPins, 600);
    } else {
      highlight.hidden = true;
    }
    if (history.replaceState) history.replaceState(null, '', '#wprc-' + id);
  }

  // --- composing -----------------------------------------------------------

  function openComposer(el, event) {
    const rect = el.getBoundingClientRect();
    state.composer = {
      url: pageUrl(),
      page_title: document.title,
      post_id: postId(),
      selector: selectorFor(el),
      snippet: snippetFor(el),
      heading: headingFor(el),
      block: blockFor(el),
      offset_x: rect.width ? (event.clientX - rect.left) / rect.width : 0,
      offset_y: rect.height ? (event.clientY - rect.top) / rect.height : 0,
      viewport: window.innerWidth + 'x' + window.innerHeight,
    };
    setCommenting(false);
    placeHighlight(el);

    const needsName = !state.me.name;
    composerEl.replaceChildren(h('form', { onsubmit: (e) => { e.preventDefault(); submitComposer(e.target); } },
      h('p', { class: 'target' }, 'On: “' + state.composer.snippet.slice(0, 70) + '”'),
      h('textarea', { name: 'text', rows: 4, required: true, placeholder: 'What should change here?',
        onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.target.form.requestSubmit(); } }),
      needsName ? h('div', { class: 'row' },
        h('input', { name: 'author_name', required: true, placeholder: 'Your name', value: store.get('name') }),
        h('input', { name: 'author_email', type: 'email', placeholder: 'Email (optional)', value: store.get('email') }),
      ) : null,
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: closeComposer }, 'Cancel'),
        h('button', { type: 'submit', class: 'primary' }, 'Post comment'),
      ),
    ));
    composerEl.hidden = false;
    const width = Math.min(340, window.innerWidth - 24);
    composerEl.style.width = width + 'px';
    composerEl.style.left = Math.max(12, Math.min(event.clientX, window.innerWidth - width - 12)) + 'px';
    composerEl.style.top = Math.max(12, Math.min(event.clientY + 12, window.innerHeight - 260)) + 'px';
    composerEl.querySelector('textarea').focus();
  }

  function closeComposer() {
    composerEl.hidden = true;
    state.composer = null;
    highlight.hidden = true;
  }

  function guestFields(form) {
    const name = form.author_name ? form.author_name.value.trim() : store.get('name');
    const email = form.author_email ? form.author_email.value.trim() : store.get('email');
    if (name) store.set('name', name);
    if (form.author_email) store.set('email', email);
    return state.me.name ? {} : { author_name: name, author_email: email };
  }

  async function submitComposer(form) {
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const thread = await api('/comments', {
        method: 'POST',
        body: JSON.stringify({ ...state.composer, ...guestFields(form), text: form.text.value }),
      });
      upsert(thread);
      closeComposer();
      focusThread(thread.id);
    } catch (error) {
      showToast(error.message);
      button.disabled = false;
    }
  }

  async function sendReply(id, form) {
    const text = form.querySelector('textarea').value.trim();
    if (!text) return;
    if (!state.me.name && !store.get('name')) {
      const name = window.prompt('Your name');
      if (!name) return;
      store.set('name', name.trim());
    }
    try {
      const thread = await api('/comments', {
        method: 'POST',
        body: JSON.stringify({ parent: id, text, ...(state.me.name ? {} : { author_name: store.get('name'), author_email: store.get('email') }) }),
      });
      delete state.drafts[id];
      form.querySelector('textarea').blur();
      upsert(thread);
    } catch (error) {
      showToast(error.message);
    }
  }

  async function setStatus(id, status) {
    try {
      upsert(await api('/comments/' + id + '/status', { method: 'POST', body: JSON.stringify({ status }) }));
    } catch (error) {
      showToast(error.message);
    }
  }

  function upsert(thread) {
    const index = state.threads.findIndex((t) => t.id === thread.id);
    if (index === -1) state.threads.push(thread);
    else state.threads[index] = thread;
    render();
  }

  function render() {
    renderToolbar();
    renderPins();
    renderPanel();
  }

  // --- page events ---------------------------------------------------------

  function pageTarget(event) {
    const el = event.target;
    return el && el !== host && el.nodeType === 1 && el !== document.documentElement && el !== document.body ? el : null;
  }

  document.addEventListener('mousemove', (event) => {
    if (!state.commenting) return;
    const el = pageTarget(event);
    if (el) placeHighlight(el);
  }, true);

  // Capture phase, so links and buttons do not act while picking a spot.
  for (const type of ['click', 'pointerdown', 'mousedown', 'submit']) {
    document.addEventListener(type, (event) => {
      if (!state.commenting || event.target === host) return;
      event.preventDefault();
      event.stopPropagation();
      if (type === 'click') {
        const el = pageTarget(event);
        if (el) openComposer(el, event);
      }
    }, true);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (state.commenting) setCommenting(false);
    else if (state.composer) closeComposer();
  });

  let frame = 0;
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(positionPins); };
  window.addEventListener('scroll', schedule, { passive: true, capture: true });
  window.addEventListener('resize', () => { elementCache.clear(); schedule(); });

  window.addEventListener('hashchange', () => {
    const match = location.hash.match(/^#wprc-(\d+)$/);
    if (match) focusThread(Number(match[1]));
  });

  // --- boot ----------------------------------------------------------------

  async function load() {
    state.threads = await api('/comments?url=' + encodeURIComponent(pageUrl()));
    elementCache.clear();
    render();
  }

  async function boot() {
    const params = new URLSearchParams(location.search);
    const token = params.get('review');
    if (token) {
      params.delete('review');
      const query = params.toString();
      history.replaceState(null, '', location.pathname + (query ? '?' + query : '') + location.hash);
      try {
        await api('/session', { method: 'POST', body: JSON.stringify({ token }) });
      } catch (error) {
        document.body.append(host);
        showToast(error.message);
        return;
      }
    }

    state.me = await api('/me');
    if (!state.me.can_comment) return;

    document.body.append(host);
    document.head.append(h('style', {}, 'html.wprc-commenting, html.wprc-commenting * { cursor: crosshair !important; }'));
    renderToolbar();
    await load();

    const match = location.hash.match(/^#wprc-(\d+)$/);
    if (match) setTimeout(() => focusThread(Number(match[1])), 300);
    else if (token) togglePanel(true);

    setInterval(() => { if (document.visibilityState === 'visible' && !state.composer) load().catch(() => {}); }, POLL_MS);
    // Late layout shifts (fonts, images, sliders) move elements after load.
    window.addEventListener('load', () => { elementCache.clear(); positionPins(); });
  }

  boot().catch((error) => console.warn('[wprc]', error));

  function CSS_TEXT() {
    return `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      [hidden] { display: none !important; }
      button { font: inherit; cursor: pointer; }
      .toolbar { position: fixed; right: 16px; bottom: 16px; display: flex; gap: 8px; }
      .toolbar button { display: inline-flex; align-items: center; gap: 6px; padding: 10px 14px; border-radius: 999px; border: 1px solid #d4d4d8; background: #fff; color: #18181b; font-size: 14px; font-weight: 600; box-shadow: 0 4px 16px rgba(0,0,0,.15); }
      .toolbar button.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
      .toolbar button.active { background: #18181b; border-color: #18181b; }
      .count { min-width: 20px; padding: 1px 6px; border-radius: 999px; background: #4f46e5; color: #fff; font-size: 12px; }
      .highlight { position: fixed; pointer-events: none; outline: 2px solid #4f46e5; outline-offset: 2px; background: rgba(79,70,229,.08); border-radius: 2px; transition: all .08s; }
      .pin { position: fixed; width: 28px; height: 28px; margin: -14px 0 0 -14px; border-radius: 50% 50% 50% 0; border: 2px solid #fff; background: #4f46e5; color: #fff; font-size: 12px; font-weight: 700; box-shadow: 0 2px 8px rgba(0,0,0,.3); padding: 0; }
      .pin.active { transform: scale(1.25); background: #18181b; }
      .status-in_progress { background: #d97706 !important; }
      .status-resolved { background: #16a34a !important; }
      .status-wontfix { background: #71717a !important; }
      .panel { position: fixed; top: 0; right: 0; bottom: 0; width: 380px; max-width: 100vw; background: #fff; color: #18181b; box-shadow: -8px 0 32px rgba(0,0,0,.18); display: flex; flex-direction: column; font-size: 14px; }
      .panel header { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid #e4e4e7; }
      .panel header strong { flex: 1; font-size: 15px; }
      .toggle { font-size: 13px; color: #52525b; display: flex; align-items: center; gap: 4px; }
      .close { border: 0; background: none; font-size: 22px; line-height: 1; color: #52525b; }
      .who { margin: 0; padding: 8px 16px; color: #71717a; font-size: 12px; border-bottom: 1px solid #f4f4f5; }
      .threads { overflow-y: auto; flex: 1; padding: 8px 0 80px; }
      .empty { padding: 16px; color: #52525b; }
      .thread { padding: 12px 16px; border-bottom: 1px solid #f4f4f5; }
      .thread.active { background: #eef2ff; }
      .meta { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; }
      .meta .time { color: #71717a; flex: 1; }
      .num { display: inline-grid; place-items: center; min-width: 22px; height: 22px; border-radius: 50%; background: #4f46e5; color: #fff; font-size: 11px; font-weight: 700; }
      .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; color: #fff; background: #4f46e5; }
      select.status { font: inherit; font-size: 12px; padding: 2px 4px; border: 1px solid #d4d4d8; border-radius: 6px; background: #fff; color: #18181b; }
      .text { margin: 6px 0 0; white-space: pre-wrap; word-break: break-word; line-height: 1.45; }
      .detached { margin: 6px 0 0; font-size: 12px; color: #b45309; }
      .reply { margin: 10px 0 0 14px; padding-left: 10px; border-left: 2px solid #e4e4e7; }
      .reply.ai { border-left-color: #a78bfa; }
      .reply .meta { cursor: default; }
      .reply-form { display: flex; gap: 6px; margin-top: 10px; }
      textarea, input { font: inherit; font-size: 14px; width: 100%; padding: 8px 10px; border: 1px solid #d4d4d8; border-radius: 8px; color: #18181b; background: #fff; resize: vertical; }
      textarea:focus, input:focus { outline: 2px solid #4f46e5; outline-offset: -1px; border-color: transparent; }
      .reply-form button, .actions button { padding: 6px 12px; border-radius: 8px; border: 1px solid #d4d4d8; background: #fff; color: #18181b; font-size: 13px; font-weight: 600; }
      .actions button.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
      .composer { position: fixed; background: #fff; color: #18181b; padding: 12px; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.25); font-size: 14px; }
      .composer form { display: grid; gap: 8px; }
      .target { margin: 0; font-size: 12px; color: #71717a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      .actions { display: flex; justify-content: flex-end; gap: 6px; }
      .toast { position: fixed; left: 50%; bottom: 72px; transform: translateX(-50%); background: #18181b; color: #fff; padding: 10px 16px; border-radius: 8px; font-size: 14px; max-width: calc(100vw - 32px); }
      @media (max-width: 600px) {
        .panel { top: auto; height: 70vh; width: 100vw; border-radius: 14px 14px 0 0; }
        .toolbar { right: 12px; bottom: 12px; }
        .row { grid-template-columns: 1fr; }
      }
    `;
  }
})();
