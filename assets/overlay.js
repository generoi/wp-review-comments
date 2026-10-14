/**
 * Review Comments overlay.
 *
 * Click "Comment" (or press C), click anything on the page (or hover it and
 * press Enter), write. Every comment stores where it was made (selector, text
 * snippet, block, heading, post ID and viewport) plus a screenshot, so it can
 * be found again by people on the page and by Claude through MCP.
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
  // Keep in sync with Store::IGNORED_PARAMS.
  const IGNORED_PARAMS = ['review', 'nocache', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'dclid', 'yclid',
    'mc_cid', 'mc_eid', '_ga', '_gl', '_hsenc', '_hsmi', 'ref', 'srsltid', 'ver', '_'];
  const WALK_KEY = 'wprc_walkthrough';

  const state = {
    me: null,
    threads: [],
    commenting: false,
    panelOpen: false,
    showDone: false,
    thisDeviceOnly: false,
    activeId: null,
    editingId: null,
    drafts: {},
    composer: null,
    hovered: null,
    pointer: { x: 0, y: 0 },
    walk: null,
  };

  // --- helpers -------------------------------------------------------------

  const store = {
    get(key) { try { return localStorage.getItem('wprc_' + key) || ''; } catch (e) { return ''; } },
    set(key, value) { try { localStorage.setItem('wprc_' + key, value); } catch (e) { /* private mode */ } },
  };

  const session = {
    get(key) { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (e) { return null; } },
    set(key, value) { try { value == null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* blocked */ } },
  };

  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (C.nonce) headers['X-WP-Nonce'] = C.nonce;
    // A unique query keeps edge caches (Kinsta, Cloudflare) out of GETs.
    if (!options.method || options.method === 'GET') path += (path.includes('?') ? '&' : '?') + '_=' + Date.now();
    const response = await fetch(C.rest + path, { credentials: 'same-origin', cache: 'no-store', ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'Request failed (' + response.status + ')');
    return data;
  }

  /** Same key as Store::normalizeUrl(). */
  function normalizeUrl(href) {
    const url = new URL(href, location.origin);
    const params = new URLSearchParams();
    [...url.searchParams.keys()].sort().forEach((key) => {
      if (!IGNORED_PARAMS.includes(key) && !key.startsWith('utm_')) params.set(key, url.searchParams.get(key));
    });
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const query = params.toString();
    return path + (query ? '?' + query : '');
  }
  const pageUrl = () => normalizeUrl(location.href);

  function device(width = window.innerWidth) {
    if (!width) return '';
    return width < 600 ? 'mobile' : width < 1024 ? 'tablet' : 'desktop';
  }

  /**
   * Readable browser and system, e.g. "Safari 18.4 · iOS 18.4 · touch · 3x".
   * Layout bugs are often specific to one browser, so reviewers' setups matter.
   */
  function browserInfo() {
    const ua = navigator.userAgent;
    const find = (pattern) => (ua.match(pattern) || [])[1];
    const browsers = [
      ['Edge', /Edg(?:iOS|A)?\/([\d.]+)/], ['Opera', /OPR\/([\d.]+)/], ['Samsung Internet', /SamsungBrowser\/([\d.]+)/],
      ['Chrome', /CriOS\/([\d.]+)/], ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/], ['Chrome', /Chrome\/([\d.]+)/],
      ['Safari', /Version\/([\d.]+).*Safari/],
    ];
    let browser = 'Unknown browser';
    for (const [name, pattern] of browsers) {
      const version = find(pattern);
      if (version) { browser = name + ' ' + version.split('.').slice(0, name === 'Safari' ? 2 : 1).join('.'); break; }
    }
    // Brave sends Chrome's or (on iOS) Safari's user agent, without a version.
    if (navigator.brave) browser = 'Brave';
    const touch = navigator.maxTouchPoints > 1;
    let system = 'Unknown system';
    if (/iPhone|iPad|iPod/.test(ua)) {
      // Since iOS 26 the system version in the user agent is frozen at 18.x;
      // Safari's own version (also sent by Brave) follows the real one.
      const webkitVersion = find(/Version\/([\d.]+)/);
      system = 'iOS ' + (webkitVersion && parseInt(webkitVersion, 10) >= 26 ? webkitVersion : (find(/OS (\d+[_\d]*)/) || '').replace(/_/g, '.'));
    }
    if (system !== 'Unknown system') { /* iOS */ } else if (/Macintosh/.test(ua)) system = touch ? 'iPadOS' : 'macOS';
    else if (/Android/.test(ua)) system = 'Android ' + (find(/Android ([\d.]+)/) || '');
    else if (/Windows/.test(ua)) system = 'Windows';
    else if (/CrOS/.test(ua)) system = 'ChromeOS';
    else if (/Linux/.test(ua)) system = 'Linux';
    const ratio = Math.round((window.devicePixelRatio || 1) * 100) / 100;
    return [browser, system.trim(), touch ? 'touch' : '', ratio !== 1 ? ratio + 'x' : ''].filter(Boolean).join(' · ');
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

  const isTyping = (event) => {
    const el = event.composedPath()[0];
    return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  };

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
    return chain.join(' / ');
  }

  function postId() {
    const match = document.body.className.match(/(?:^|\s)(?:postid|page-id)-(\d+)/);
    return match ? Number(match[1]) : 0;
  }

  /** Find a thread's element again: selector first, then its text. */
  /** A general comment: about the whole page, not one element. */
  const isPageComment = (thread) => !thread.selector;

  function findElement(thread) {
    if (isPageComment(thread)) return null;
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
  const hint = h('div', { class: 'hint', hidden: true },
    'Click what you want to comment on, or hover it and press Enter. Esc cancels. ',
    h('button', { class: 'link light', onclick: () => openComposer(null) }, 'General comment'));
  const walkBar = h('div', { class: 'walkbar', hidden: true });
  const toolbar = h('div', { class: 'toolbar' });
  const panel = h('aside', { class: 'panel', hidden: true });
  const composerEl = h('div', { class: 'composer', hidden: true });
  const toast = h('div', { class: 'toast', hidden: true });
  root.append(pinLayer, highlight, walkBar, hint, toolbar, panel, composerEl, toast);
  // Clicks in the overlay must not reach the page: menus and modals close on
  // "click outside", which would hide the element being commented on.
  for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'focusin', 'keydown', 'keyup']) {
    host.addEventListener(type, (event) => event.stopPropagation());
  }

  function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.hidden = true; }, 5000);
  }

  /** Threads shown with the current filters. */
  function shown(thread) {
    if (thread.id === state.activeId) return true;
    if (!state.showDone && DONE.includes(thread.status)) return false;
    if (state.thisDeviceOnly && thread.device && thread.device !== device()) return false;
    return true;
  }

  function renderToolbar() {
    const open = state.threads.filter((t) => !DONE.includes(t.status)).length;
    toolbar.replaceChildren(
      h('button', {
        class: 'primary' + (state.commenting ? ' active' : ''),
        title: 'Comment on part of the page (shortcut: C)',
        onclick: () => setCommenting(!state.commenting),
      }, state.commenting ? 'Cancel' : '+ Comment'),
      h('button', { title: 'Comments on this page', onclick: () => togglePanel() }, 'Threads', h('span', { class: 'count' }, String(open))),
    );
  }

  function setCommenting(on) {
    state.commenting = on;
    document.documentElement.classList.toggle('wprc-commenting', on);
    hint.hidden = !on;
    if (on) {
      closeComposer();
      // On phones the panel covers most of the page; get it out of the way.
      if (window.innerWidth < 600) togglePanel(false);
      if (state.hovered) placeHighlight(state.hovered);
      // Ready before picking, so the page is copied before anything changes.
      loadScreenshotLibrary().catch(() => {});
    } else {
      highlight.hidden = true;
    }
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
    const items = numbered().filter(shown);
    pinLayer.replaceChildren(...items.map((thread) => {
      const pin = h('button', {
        class: 'pin status-' + thread.status + (thread.id === state.activeId ? ' active' : '') + (thread.device && thread.device !== device() ? ' other-device' : ''),
        title: thread.author + (thread.device ? ' (' + thread.device + ')' : '') + ': ' + thread.text.slice(0, 80),
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
    if (state.activeId && !highlight.hidden && !state.commenting && !state.composer) {
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

  function whoAmI() {
    return state.me.name || store.get('name') || 'Guest reviewer';
  }

  function renderPanel() {
    if (!state.panelOpen) return;
    // Do not wipe what someone is typing; the next poll catches up.
    if (root.activeElement && panel.contains(root.activeElement) && root.activeElement.tagName === 'TEXTAREA') return;

    const items = numbered().filter(shown).reverse();
    const hidden = state.threads.length - items.length;
    panel.replaceChildren(
      h('header', {},
        h('strong', {}, 'Review comments'),
        h('button', { class: 'walk', title: 'A comment about the whole page, not one element', onclick: () => openComposer(null) }, '+ General comment'),
        h('button', { class: 'walk', title: 'Step through every open comment on the site', onclick: startWalkthrough }, 'Walkthrough'),
        h('button', { class: 'close', title: 'Close', onclick: () => togglePanel(false) }, '×'),
      ),
      h('div', { class: 'filters' },
        h('label', {}, h('input', { type: 'checkbox', checked: state.showDone, onchange: (e) => { state.showDone = e.target.checked; render(); } }), ' Show resolved'),
        h('label', {}, h('input', { type: 'checkbox', checked: state.thisDeviceOnly, onchange: (e) => { state.thisDeviceOnly = e.target.checked; render(); } }), ' Only ' + device()),
      ),
      h('p', { class: 'who' }, 'Commenting as ' + whoAmI(), state.me.round ? ' · ' + state.me.round : ''),
      items.length
        ? h('div', { class: 'threads' }, items.map(renderThread), hidden ? h('p', { class: 'more' }, hidden + ' hidden by filters') : null)
        : h('p', { class: 'empty' }, hidden
          ? hidden + ' comment' + (hidden === 1 ? ' is' : 's are') + ' hidden by the filters above.'
          : 'No comments on this page yet. Click “+ Comment” (or press C) and then the part of the page you want to comment on.'),
    );
  }

  function renderBody(comment) {
    if (comment.deleted) return h('p', { class: 'text deleted' }, 'Comment deleted');
    if (state.editingId === comment.id) {
      return h('form', { class: 'edit-form', onsubmit: (e) => { e.preventDefault(); saveEdit(comment.id, e.target); } },
        h('textarea', { rows: 3, value: comment.text, onkeydown: (e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.target.form.requestSubmit();
          if (e.key === 'Escape') { e.stopPropagation(); state.editingId = null; e.target.blur(); renderPanel(); }
        } }),
        h('div', { class: 'actions' },
          h('button', { type: 'button', onclick: () => { state.editingId = null; renderPanel(); } }, 'Cancel'),
          h('button', { type: 'submit', class: 'primary' }, 'Save'),
        ),
      );
    }
    return h('p', { class: 'text' }, comment.text, comment.edited ? h('span', { class: 'edited' }, ' (edited)') : null);
  }

  function ownActions(comment) {
    if (!comment.can_modify || comment.deleted || state.editingId === comment.id) return null;
    return h('span', { class: 'own' },
      h('button', { class: 'link', onclick: (e) => { e.stopPropagation(); state.editingId = comment.id; renderPanel(); focusEditor(); } }, 'Edit'),
      h('button', { class: 'link danger', onclick: (e) => { e.stopPropagation(); removeComment(comment.id); } }, 'Delete'),
    );
  }

  function focusEditor() {
    const textarea = panel.querySelector('.edit-form textarea');
    if (textarea) { textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length); }
  }

  function renderThread(thread) {
    const el = findElementCached(thread);
    const where = isPageComment(thread) ? '' : !el
      ? 'Not found at this screen size' + (thread.device ? ' (written on ' + thread.device + ')' : '')
      : !visible(el) ? 'Hidden right now: it may be in a menu, tab or slide that is closed' : '';
    return h('article', { class: 'thread' + (thread.id === state.activeId ? ' active' : '') },
      h('div', { class: 'meta', onclick: () => focusThread(thread.id) },
        h('span', { class: 'num status-' + thread.status }, String(thread.n)),
        h('strong', {}, thread.author),
        h('span', { class: 'time' }, timeAgo(thread.created)),
        isPageComment(thread) ? h('span', { class: 'device page' }, 'General') : null,
        thread.device ? h('span', { class: 'device' + (thread.device !== device() ? ' other' : ''), title: 'Written at ' + thread.viewport + (thread.browser ? ' · ' + thread.browser : '') }, thread.device) : null,
        state.me.is_editor
          ? h('select', { class: 'status', title: 'Status', onclick: (e) => e.stopPropagation(), onchange: (e) => setStatus(thread.id, e.target.value) },
            Object.entries(STATUS_LABELS).map(([value, label]) => h('option', { value, selected: value === thread.status }, label)))
          : h('span', { class: 'badge status-' + thread.status }, STATUS_LABELS[thread.status]),
      ),
      renderBody(thread),
      ownActions(thread),
      thread.screenshot ? h('a', { class: 'shot', href: thread.screenshot, target: '_blank', rel: 'noopener', title: 'What the reviewer saw' },
        h('img', { src: thread.screenshot, alt: 'Screenshot when the comment was written', loading: 'lazy' })) : null,
      thread.screenshotFailed ? h('p', { class: 'note' }, 'No screenshot: this browser blocked it. The comment itself is saved.') : null,
      where ? h('p', { class: 'detached' }, where + '. It was: “' + thread.snippet + '”') : null,
      thread.replies.map((reply) => h('div', { class: 'reply' + (reply.author_type === 'ai' ? ' ai' : '') },
        h('div', { class: 'meta' }, h('strong', {}, reply.author), h('span', { class: 'time' }, timeAgo(reply.created)), ownActions(reply)),
        renderBody(reply),
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

  function focusThread(id, { scroll = true } = {}) {
    state.activeId = id;
    const thread = state.threads.find((t) => t.id === id);
    togglePanel(true);
    renderPins();
    const el = thread && findElementCached(thread);
    if (el) {
      if (scroll) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      placeHighlight(el);
      setTimeout(positionPins, 600);
    } else {
      highlight.hidden = true;
    }
    const card = panel.querySelector('.thread.active');
    if (card) card.scrollIntoView({ block: 'nearest' });
    if (history.replaceState) history.replaceState(null, '', '#wprc-' + id);
  }

  // --- composing -----------------------------------------------------------

  /**
   * Compose a comment on an element, or a general comment when el is null.
   */
  function openComposer(el, point = { x: 0, y: 0 }) {
    const rect = el ? el.getBoundingClientRect() : null;
    const inside = rect && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    state.composer = {
      url: pageUrl(),
      page_title: document.title,
      post_id: postId(),
      selector: el ? selectorFor(el) : '',
      snippet: el ? snippetFor(el) : '',
      heading: el ? headingFor(el) : '',
      block: el ? blockFor(el) : '',
      offset_x: inside && rect.width ? (point.x - rect.left) / rect.width : 0.5,
      offset_y: inside && rect.height ? (point.y - rect.top) / rect.height : 0.5,
      viewport: window.innerWidth + 'x' + window.innerHeight,
      browser: browserInfo(),
    };
    // Picture the page now, while menus or slides are still as the reviewer
    // sees them; it is uploaded once the comment is saved.
    let copied;
    const pageCopied = new Promise((resolve) => { copied = resolve; });
    state.composer.shot = takeScreenshot(el, copied);
    state.composer.shot.catch(() => {}).finally(copied);
    setCommenting(false);
    if (el) placeHighlight(el);
    else highlight.hidden = true;
    if (!el && window.innerWidth < 600) togglePanel(false);

    // Guests type their name once; after that it is remembered in this browser.
    const askName = !state.me.name && !store.get('name');
    const noAutofill = { autocomplete: 'off', 'data-1p-ignore': '', 'data-lpignore': 'true', 'data-form-type': 'other' };
    const nameFields = h('div', { class: 'row' + (state.me.asks_email ? '' : ' single'), hidden: !askName },
      h('input', { name: 'author_name', required: askName, placeholder: 'Your name', value: store.get('name'), ...noAutofill }),
      state.me.asks_email ? h('input', { name: 'author_email', type: 'email', placeholder: 'Email for replies (optional)', title: 'Only used to email you when someone replies to this thread', value: store.get('email'), ...noAutofill }) : null,
    );
    const asWho = !state.me.name && !askName ? h('p', { class: 'as' }, 'Commenting as ' + store.get('name') + ' · ',
      h('button', { type: 'button', class: 'link', onclick: (e) => { nameFields.hidden = false; nameFields.querySelector('input').required = true; e.target.parentNode.remove(); } }, 'change')) : null;

    composerEl.replaceChildren(h('form', { onsubmit: (e) => { e.preventDefault(); submitComposer(e.target); } },
      h('p', { class: 'target' }, el ? 'On: “' + state.composer.snippet.slice(0, 70) + '”' : 'General comment on: ' + document.title),
      h('textarea', { name: 'text', rows: 4, required: true, placeholder: el ? 'What should change here?' : 'What should change on this page?',
        onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.target.form.requestSubmit(); } }),
      state.me.name ? null : nameFields,
      asWho,
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: closeComposer }, 'Cancel'),
        h('button', { type: 'submit', class: 'primary' }, 'Post comment'),
      ),
    ));
    composerEl.hidden = false;
    const width = Math.min(340, window.innerWidth - 24);
    composerEl.style.width = width + 'px';
    if (window.innerWidth < 600 || !el) {
      // Phones, and general comments: dock above the toolbar (on phones the
      // keyboard then does not hide it).
      Object.assign(composerEl.style, { left: 'auto', right: '16px', top: 'auto', bottom: '64px' });
      if (window.innerWidth < 600) Object.assign(composerEl.style, { left: '12px', right: 'auto' });
    } else {
      Object.assign(composerEl.style, {
        left: Math.max(12, Math.min(point.x, window.innerWidth - width - 12)) + 'px',
        right: 'auto',
        top: Math.max(12, Math.min(point.y + 12, window.innerHeight - 280)) + 'px',
        bottom: 'auto',
      });
    }
    // Focus moves only once the screenshot has copied the page: many menus
    // close when focus leaves them.
    const textarea = composerEl.querySelector('textarea');
    Promise.race([pageCopied, new Promise((resolve) => setTimeout(resolve, 1500))])
      .then(() => { if (textarea.isConnected && !composerEl.hidden) textarea.focus(); });
  }

  function closeComposer() {
    composerEl.hidden = true;
    state.composer = null;
    highlight.hidden = true;
  }

  function guestFields(form) {
    if (state.me.name) return {};
    const name = form.author_name ? form.author_name.value.trim() : store.get('name');
    const email = form.author_email ? form.author_email.value.trim() : (state.me.asks_email ? store.get('email') : '');
    if (name) store.set('name', name);
    if (form.author_email) store.set('email', email);
    return { author_name: name, author_email: email };
  }

  async function submitComposer(form) {
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    const { shot, ...where } = state.composer;
    try {
      const thread = await api('/comments', {
        method: 'POST',
        body: JSON.stringify({ ...where, ...guestFields(form), text: form.text.value }),
      });
      upsert(thread);
      closeComposer();
      focusThread(thread.id, { scroll: false });
      uploadScreenshot(thread.id, shot);
    } catch (error) {
      showToast(error.message);
      button.disabled = false;
    }
  }

  async function sendReply(id, form) {
    const textarea = form.querySelector('textarea');
    const text = textarea.value.trim();
    if (!text) return;
    if (!state.me.name && !store.get('name')) {
      const name = window.prompt('Your name');
      if (!name) return;
      store.set('name', name.trim());
    }
    try {
      const thread = await api('/comments', {
        method: 'POST',
        body: JSON.stringify({ parent: id, text, ...(state.me.name ? {} : { author_name: store.get('name'), author_email: state.me.asks_email ? store.get('email') : '' }) }),
      });
      delete state.drafts[id];
      textarea.value = '';
      textarea.blur();
      upsert(thread);
    } catch (error) {
      showToast(error.message);
    }
  }

  async function saveEdit(id, form) {
    try {
      const thread = await api('/comments/' + id, { method: 'PUT', body: JSON.stringify({ text: form.querySelector('textarea').value }) });
      state.editingId = null;
      form.querySelector('textarea').blur();
      upsert(thread);
    } catch (error) {
      showToast(error.message);
    }
  }

  async function removeComment(id) {
    if (!window.confirm('Delete this comment?')) return;
    try {
      const result = await api('/comments/' + id, { method: 'DELETE' });
      if (result.thread) upsert(result.thread);
      else {
        const gone = result.removed || id;
        state.threads = state.threads.filter((t) => t.id !== gone);
        if (state.activeId === gone) { state.activeId = null; highlight.hidden = true; }
        render();
      }
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

  // --- screenshots ---------------------------------------------------------

  let libraryPromise = null;
  function loadScreenshotLibrary() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    libraryPromise ||= new Promise((resolve, reject) => {
      const script = h('script', { src: C.screenshotLibrary, async: true });
      script.onload = () => (window.html2canvas ? resolve(window.html2canvas) : reject(new Error('Screenshot library missing')));
      script.onerror = () => reject(new Error('Screenshot library failed to load'));
      document.head.append(script);
    });
    return libraryPromise;
  }

  /**
   * Picture of the visible part of the page with the element outlined, as a
   * JPEG data URL. html2canvas clones the DOM when called, so this records
   * the moment of picking even though rendering finishes later.
   */
  async function takeScreenshot(el, onCopied = () => {}) {
    if (!C.screenshotLibrary) return null;
    const rect = el ? el.getBoundingClientRect() : null;
    const view = { x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight };
    if (!canvasReadable()) throw new Error('This browser blocks reading canvases (fingerprinting protection)');
    const html2canvas = await loadScreenshotLibrary();
    const scale = Math.min(1, 1440 / view.width);
    // html2canvas copies the page into a viewport-sized iframe and scrolls it.
    // WebKit (Safari, and every browser on iOS) refuses that scroll, leaving
    // all but the top of the copy blank, so give it a copy as tall as the page.
    const webkit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|OPR/.test(navigator.userAgent);
    const canvas = await html2canvas(document.documentElement, {
      ...view,
      windowWidth: document.documentElement.clientWidth,
      windowHeight: webkit ? document.documentElement.scrollHeight : view.height,
      scale,
      useCORS: true,
      logging: false,
      backgroundColor: '#ffffff',
      ignoreElements: (node) => node === host,
      onclone: (doc) => {
        fixClone(doc);
        onCopied();
      },
    });
    const ctx = canvas.getContext('2d');
    // html2canvas leaves the context scaled and shifted by the scroll offset.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (rect) {
      ctx.strokeStyle = '#4f46e5';
      ctx.lineWidth = 3;
      ctx.strokeRect(rect.left * scale, rect.top * scale, rect.width * scale, rect.height * scale);
    }
    return canvas.toDataURL('image/jpeg', 0.72);
  }

  /**
   * Things html2canvas's copy of the page loses:
   * - constructed stylesheets (document.adoptedStyleSheets, used by Cookiebot
   *   and web components), which cloning does not carry over;
   * - the picture in a video, since the copy does not play.
   * Styles added to the copy carry the page's CSP nonce, as nonce-based
   * policies ignore 'unsafe-inline'.
   */
  function fixClone(doc) {
    const nonce = (document.querySelector('script[nonce], style[nonce], link[nonce]') || {}).nonce || '';
    try {
      const css = [...(document.adoptedStyleSheets || [])]
        .map((sheet) => [...sheet.cssRules].map((rule) => rule.cssText).join('\n'))
        .join('\n');
      if (css) {
        const style = doc.createElement('style');
        if (nonce) style.nonce = nonce;
        style.textContent = css;
        doc.head.append(style);
      }
    } catch (e) { /* a cross-origin sheet; skip */ }

    const originals = [...document.querySelectorAll('video')];
    [...doc.querySelectorAll('video')].forEach((copy, i) => {
      const video = originals[i];
      if (!video) return;
      let src = video.poster || '';
      if (video.videoWidth) {
        try {
          const frame = document.createElement('canvas');
          frame.width = video.videoWidth;
          frame.height = video.videoHeight;
          frame.getContext('2d').drawImage(video, 0, 0);
          src = frame.toDataURL('image/jpeg', 0.8);
        } catch (e) { /* cross-origin video without CORS: keep the poster */ }
      }
      if (!src) return;
      {
        const img = doc.createElement('img');
        img.src = src;
        img.className = copy.className;
        img.setAttribute('style', copy.getAttribute('style') || '');
        const cs = getComputedStyle(video);
        Object.assign(img.style, { width: cs.width, height: cs.height, objectFit: cs.objectFit, objectPosition: cs.objectPosition });
        copy.replaceWith(img);
      }
    });
  }

  /**
   * Brave and some privacy settings return blank or noisy pixels from
   * canvases; a screenshot from them would be a white rectangle.
   */
  function canvasReadable() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 4;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, 4, 4);
      const [r, g, b, a] = ctx.getImageData(1, 1, 1, 1).data;
      return r > 200 && g < 60 && b < 60 && a > 200;
    } catch (e) {
      return false;
    }
  }

  /** Sent after the comment is saved, so a failed capture never loses a comment. */
  async function uploadScreenshot(id, shot) {
    try {
      const image = await shot;
      if (!image) return;
      const result = await api('/comments/' + id + '/screenshot', { method: 'POST', body: JSON.stringify({ image }) });
      const target = state.threads.find((t) => t.id === id);
      if (target) { target.screenshot = result.screenshot; renderPanel(); }
    } catch (error) {
      console.warn('[wprc] screenshot', error);
      const target = state.threads.find((t) => t.id === id);
      if (target) { target.screenshotFailed = true; renderPanel(); }
    }
  }

  // --- walkthrough ---------------------------------------------------------

  async function startWalkthrough() {
    try {
      const all = await api('/threads');
      const items = all
        .filter((t) => state.showDone || !DONE.includes(t.status))
        .sort((a, b) => a.url.localeCompare(b.url) || a.created.localeCompare(b.created))
        .map((t) => ({ id: t.id, url: t.url, title: t.page_title }));
      if (!items.length) { showToast('No open comments to walk through.'); return; }
      const here = items.findIndex((t) => normalizeUrl(t.url) === pageUrl());
      state.walk = { items, index: Math.max(0, here) };
      session.set(WALK_KEY, state.walk);
      goToWalkItem();
    } catch (error) {
      showToast(error.message);
    }
  }

  function goToWalkItem() {
    const item = state.walk.items[state.walk.index];
    session.set(WALK_KEY, state.walk);
    if (normalizeUrl(item.url) !== pageUrl()) {
      location.href = item.url + '#wprc-' + item.id;
      return;
    }
    renderWalkBar();
    if (state.threads.some((t) => t.id === item.id)) focusThread(item.id);
    else showToast('That comment no longer exists.');
  }

  function stepWalk(delta) {
    const next = state.walk.index + delta;
    if (next < 0 || next >= state.walk.items.length) return;
    state.walk.index = next;
    goToWalkItem();
  }

  function stopWalkthrough() {
    state.walk = null;
    session.set(WALK_KEY, null);
    walkBar.hidden = true;
  }

  function renderWalkBar() {
    if (!state.walk) { walkBar.hidden = true; return; }
    const { items, index } = state.walk;
    walkBar.replaceChildren(
      h('button', { title: 'Previous (←)', disabled: index === 0, onclick: () => stepWalk(-1) }, '‹'),
      h('span', { class: 'pos' }, 'Comment ' + (index + 1) + ' of ' + items.length),
      h('span', { class: 'page' }, items[index].title || items[index].url),
      h('button', { title: 'Next (→)', disabled: index === items.length - 1, onclick: () => stepWalk(1) }, '›'),
      h('button', { class: 'end', title: 'End walkthrough', onclick: stopWalkthrough }, 'Done'),
    );
    walkBar.hidden = false;
  }

  // --- page events ---------------------------------------------------------

  function pageTarget(event) {
    const el = event.target;
    return el && el !== host && el.nodeType === 1 && el !== document.documentElement && el !== document.body ? el : null;
  }

  document.addEventListener('mousemove', (event) => {
    state.pointer = { x: event.clientX, y: event.clientY };
    const el = pageTarget(event);
    if (el) state.hovered = el;
    if (state.commenting && el) placeHighlight(el);
  }, true);

  // Capture phase, so links and buttons do not act while picking a spot.
  for (const type of ['click', 'pointerdown', 'mousedown', 'submit']) {
    document.addEventListener(type, (event) => {
      if (!state.commenting || event.target === host) return;
      event.preventDefault();
      event.stopPropagation();
      if (type === 'click') {
        const el = pageTarget(event);
        if (el) openComposer(el, { x: event.clientX, y: event.clientY });
      }
    }, true);
  }

  // Capture phase too: Enter must not activate the hovered link.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.commenting) setCommenting(false);
      else if (state.composer) closeComposer();
      return;
    }
    if (isTyping(event) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (state.commenting && event.key === 'Enter' && state.hovered) {
      event.preventDefault();
      event.stopPropagation();
      openComposer(state.hovered, state.pointer);
    } else if (event.key === 'c' || event.key === 'C') {
      // Opening a dropdown first and then pressing C keeps it open, unlike
      // clicking the button, which counts as a click outside the menu.
      event.preventDefault();
      setCommenting(!state.commenting);
    } else if (state.walk && event.key === 'ArrowRight') {
      stepWalk(1);
    } else if (state.walk && event.key === 'ArrowLeft') {
      stepWalk(-1);
    }
  }, true);

  let frame = 0;
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(positionPins); };
  window.addEventListener('scroll', schedule, { passive: true, capture: true });
  let lastDevice = device();
  window.addEventListener('resize', () => {
    elementCache.clear();
    schedule();
    if (device() !== lastDevice) { lastDevice = device(); render(); }
  });

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

  const canRefresh = () => document.visibilityState === 'visible' && !state.composer && state.editingId === null;

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

    // The loader's /boot answer saves two round trips, unless a review link
    // just started the session and changed who we are.
    const boot = !token && window.wprcBoot && window.wprcBoot.me ? window.wprcBoot : null;
    state.me = boot ? boot.me : await api('/me');
    if (!state.me.can_comment) return;

    document.body.append(host);
    document.head.append(h('style', {}, 'html.wprc-commenting, html.wprc-commenting * { cursor: crosshair !important; }'));
    renderToolbar();
    if (boot && Array.isArray(boot.threads)) {
      state.threads = boot.threads;
      render();
    } else {
      await load();
    }

    state.walk = session.get(WALK_KEY);
    const match = location.hash.match(/^#wprc-(\d+)$/);
    if (state.walk) {
      renderWalkBar();
      const item = state.walk.items[state.walk.index];
      if (item && normalizeUrl(item.url) === pageUrl()) setTimeout(() => focusThread(item.id), 300);
    } else if (match) {
      setTimeout(() => focusThread(Number(match[1])), 300);
    } else if (token) {
      togglePanel(true);
    }

    setInterval(() => { if (canRefresh()) load().catch(() => {}); }, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (canRefresh()) load().catch(() => {}); });
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
      .hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); background: #18181b; color: #fff; padding: 8px 14px; border-radius: 8px; font-size: 13px; max-width: calc(100vw - 24px); text-align: center; pointer-events: none; }
      .hint .link { pointer-events: auto; }
      .link.light { color: #c7d2fe; font-size: 13px; }
      .device.page { background: #eef2ff; color: #3730a3; }
      .highlight { position: fixed; pointer-events: none; outline: 2px solid #4f46e5; outline-offset: 2px; background: rgba(79,70,229,.08); border-radius: 2px; transition: all .08s; }
      .pin { position: fixed; width: 28px; height: 28px; margin: -14px 0 0 -14px; border-radius: 50% 50% 50% 0; border: 2px solid #fff; background: #4f46e5; color: #fff; font-size: 12px; font-weight: 700; box-shadow: 0 2px 8px rgba(0,0,0,.3); padding: 0; }
      .pin.active { transform: scale(1.25); background: #18181b; }
      .pin.other-device { opacity: .55; border-style: dashed; }
      .status-in_progress { background: #d97706 !important; }
      .status-resolved { background: #16a34a !important; }
      .status-wontfix { background: #71717a !important; }
      .panel { position: fixed; top: 0; right: 0; bottom: 0; width: 380px; max-width: 100%; background: #fff; color: #18181b; box-shadow: -8px 0 32px rgba(0,0,0,.18); display: flex; flex-direction: column; font-size: 14px; }
      .panel header { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid #e4e4e7; }
      .panel header strong { flex: 1; font-size: 15px; }
      .walk { padding: 4px 10px; border-radius: 999px; border: 1px solid #c7d2fe; background: #eef2ff; color: #3730a3; font-size: 12px; font-weight: 600; }
      .filters { display: flex; gap: 14px; padding: 8px 16px; border-bottom: 1px solid #f4f4f5; font-size: 13px; color: #52525b; }
      .filters label { display: flex; align-items: center; gap: 4px; }
      .close { border: 0; background: none; font-size: 22px; line-height: 1; color: #52525b; }
      .who { margin: 0; padding: 8px 16px; color: #71717a; font-size: 12px; border-bottom: 1px solid #f4f4f5; }
      .threads { overflow-y: auto; flex: 1; padding: 8px 0 80px; }
      .empty, .more { padding: 16px; color: #52525b; margin: 0; }
      .more { font-size: 12px; }
      .thread { padding: 12px 16px; border-bottom: 1px solid #f4f4f5; }
      .thread.active { background: #eef2ff; }
      .meta { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; }
      .meta .time { color: #71717a; flex: 1; }
      .num { display: inline-grid; place-items: center; min-width: 22px; height: 22px; border-radius: 50%; background: #4f46e5; color: #fff; font-size: 11px; font-weight: 700; }
      .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; color: #fff; background: #4f46e5; }
      .device { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: #f4f4f5; color: #52525b; }
      .device.other { background: #fef3c7; color: #92400e; }
      select.status { font: inherit; font-size: 12px; padding: 2px 4px; border: 1px solid #d4d4d8; border-radius: 6px; background: #fff; color: #18181b; }
      .text { margin: 6px 0 0; white-space: pre-wrap; word-break: break-word; line-height: 1.45; }
      .text.deleted { color: #a1a1aa; font-style: italic; }
      .edited { color: #a1a1aa; font-size: 12px; }
      .own { display: inline-flex; gap: 10px; margin-top: 4px; }
      .meta .own { margin: 0 0 0 auto; }
      .shot { display: block; margin-top: 8px; }
      .shot img { display: block; width: 100%; max-height: 160px; object-fit: cover; object-position: top; border-radius: 6px; border: 1px solid #e4e4e7; }
      .note { margin: 6px 0 0; font-size: 12px; color: #71717a; }
      .detached { margin: 6px 0 0; font-size: 12px; color: #b45309; }
      .reply { margin: 10px 0 0 14px; padding-left: 10px; border-left: 2px solid #e4e4e7; }
      .reply.ai { border-left-color: #a78bfa; }
      .reply .meta { cursor: default; }
      .reply-form { display: flex; gap: 6px; margin-top: 10px; }
      .edit-form { display: grid; gap: 6px; margin-top: 6px; }
      textarea, input[type=text], input:not([type]), input[type=email] { font: inherit; font-size: 16px; width: 100%; padding: 8px 10px; border: 1px solid #d4d4d8; border-radius: 8px; color: #18181b; background: #fff; resize: vertical; }
      textarea:focus, input:focus { outline: 2px solid #4f46e5; outline-offset: -1px; border-color: transparent; }
      .reply-form button, .actions button { padding: 6px 12px; border-radius: 8px; border: 1px solid #d4d4d8; background: #fff; color: #18181b; font-size: 13px; font-weight: 600; }
      .actions button.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
      .link { border: 0; background: none; padding: 0; color: #4f46e5; font-size: 12px; text-decoration: underline; }
      .link.danger { color: #b91c1c; }
      .composer { position: fixed; background: #fff; color: #18181b; padding: 12px; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.25); font-size: 14px; }
      .composer form { display: grid; gap: 8px; }
      .target { margin: 0; font-size: 12px; color: #71717a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .as { margin: 0; font-size: 12px; color: #71717a; }
      .row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      .row.single { grid-template-columns: 1fr; }
      .actions { display: flex; justify-content: flex-end; gap: 6px; }
      .walkbar:not([hidden]) + .hint { top: 58px; }
      .walkbar { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; padding: 6px 8px 6px 6px; background: #18181b; color: #fff; border-radius: 999px; font-size: 13px; box-shadow: 0 6px 24px rgba(0,0,0,.25); max-width: calc(100vw - 24px); }
      .walkbar button { border: 0; background: #3f3f46; color: #fff; border-radius: 999px; min-width: 30px; height: 30px; font-size: 18px; line-height: 1; }
      .walkbar button:disabled { opacity: .35; cursor: default; }
      .walkbar .end { font-size: 13px; padding: 0 12px; background: #4f46e5; }
      .walkbar .pos { font-weight: 600; white-space: nowrap; }
      .walkbar .page { color: #a1a1aa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
      .toast { position: fixed; left: 50%; bottom: 72px; transform: translateX(-50%); background: #18181b; color: #fff; padding: 10px 16px; border-radius: 8px; font-size: 14px; max-width: calc(100vw - 32px); }
      @media (max-width: 600px) {
        .panel { top: auto; left: 0; right: 0; width: auto; height: 70vh; border-radius: 14px 14px 0 0; }
        .toolbar { right: 12px; bottom: 12px; }
        .row { grid-template-columns: 1fr; }
        .walkbar .page { display: none; }
        .hint { top: auto; bottom: 64px; }
      }
    `;
  }
})();
