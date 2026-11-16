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
  // Set when a page in the site summary is opened, so the panel opens there too.
  const PANEL_KEY = 'wprc_panel';
  const SIZES = ['desktop', 'tablet', 'mobile'];
  const SIZE_LABELS = { desktop: 'Desktop', tablet: 'Tablet', mobile: 'Mobile' };

  const state = {
    me: null,
    threads: [],
    commenting: false,
    panelOpen: false,
    // 'todo' (open and in progress), 'done' (resolved and won't fix) or 'all'.
    statusFilter: 'todo',
    // '' for every screen size, or one of SIZES.
    sizeFilter: '',
    // 'page' lists this page's threads; 'site' summarises the whole site.
    scope: 'page',
    // Every thread on the site, from /threads, once the panel has opened.
    site: null,
    siteError: null,
    menuOpen: false,
    activeId: null,
    // The thread open in the panel's detail view.
    detailId: null,
    hoverId: null,
    editingId: null,
    drafts: {},
    composer: null,
    hovered: null,
    pointer: { x: 0, y: 0 },
    walk: null,
    pageKey: null,
    mutations: 0,
    composerEl: null,
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
    headers['X-WPRC'] = '1';
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
  /** This page's key: the server's when known, so comparisons match it exactly. */
  const pageUrl = () => state.pageKey || normalizeUrl(location.href);

  function device(width = window.innerWidth) {
    if (!width) return '';
    return width < 600 ? 'mobile' : width < 1024 ? 'tablet' : 'desktop';
  }

  /**
   * Readable browser and system, e.g. "Safari 18.4, iOS 18.4, touch, 3x".
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
    return [browser, system.trim(), touch ? 'touch' : '', ratio !== 1 ? ratio + 'x' : ''].filter(Boolean).join(', ');
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
    for (const child of children.flat(Infinity)) {
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
  // Comment mode lives in the panel; this small hint is for when the panel is
  // closed while picking (on phones, where the panel would cover the page).
  const hint = h('div', { class: 'hint', hidden: true, role: 'status' });
  const fab = h('button', { class: 'fab', hidden: true, title: 'Open the review panel', onclick: () => togglePanel(true) });
  const panel = h('aside', { class: 'panel', hidden: true, 'aria-label': 'Review comments' });
  const composerEl = h('div', { class: 'composer', hidden: true });
  const toast = h('div', { class: 'toast', hidden: true, role: 'status' });
  root.append(pinLayer, highlight, hint, panel, fab, composerEl, toast);
  // Clicks in the overlay must not reach the page: menus and modals close on
  // "click outside", which would hide the element being commented on.
  for (const type of ['click', 'dblclick', 'contextmenu', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'pointermove', 'touchstart', 'touchend', 'focusin', 'focusout', 'keydown', 'keypress', 'keyup', 'input', 'wheel']) {
    host.addEventListener(type, (event) => event.stopPropagation());
  }
  // A click anywhere in the panel outside the ⋯ menu closes it.
  panel.addEventListener('click', (event) => {
    if (state.menuOpen && !event.composedPath().some((node) => node.classList && node.classList.contains('menu'))) {
      state.menuOpen = false;
      renderPanel();
    }
  });

  const ICONS = {
    close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    more: '<svg width="18" height="18" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>',
  };
  function icon(name) {
    const span = h('span', { class: 'icon', 'aria-hidden': 'true' });
    span.innerHTML = ICONS[name];
    return span;
  }

  function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.hidden = true; }, 5000);
  }

  const isTodo = (thread) => !DONE.includes(thread.status);
  const matchesStatus = (thread) => state.statusFilter === 'all' || (state.statusFilter === 'done' ? !isTodo(thread) : isTodo(thread));
  const matchesSize = (thread) => !state.sizeFilter || !thread.device || thread.device === state.sizeFilter;

  /** Threads shown with the current filters. */
  function shown(thread) {
    if (thread.id === state.activeId) return true;
    return matchesStatus(thread) && matchesSize(thread);
  }

  /** "/contact" as the site writes its links ("/contact/"), for showing and opening. */
  function displayPath(key) {
    const [path, query] = (key || '/').split('?');
    const slash = location.pathname.endsWith('/') && path !== '/' && !/\.[a-z0-9]+$/i.test(path);
    return path + (slash ? '/' : '') + (query ? '?' + query : '');
  }

  /** A page title without the site name the theme appends ("Contact – Site"). */
  function shortTitle(title) {
    const split = (text) => (text || '').split(/\s[–—|-]\s/);
    const parts = split(title);
    const site = split(document.title);
    return parts.length > 1 && parts[parts.length - 1] === site[site.length - 1] ? parts.slice(0, -1).join(' – ') : (title || '');
  }

  const cut = (text, max) => (text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text);
  const statusPill = (status) => h('span', { class: 'st st-' + status }, STATUS_LABELS[status] || status);
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const initials = (name) => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('');
  const browserLabel = (text) => (text || '').replace(/ · /g, ', ');

  function blockLabel(block) {
    const first = (block || '').split(' / ')[0].replace(/^wp-block-/, '').replace(/-/g, ' ');
    return first ? first[0].toUpperCase() + first.slice(1) + ' block' : '';
  }

  /** Where on the page a thread is, from the heading, snippet and block it stored. */
  function whereLabel(thread) {
    if (isPageComment(thread)) return 'Whole page';
    const snippet = thread.snippet && !thread.snippet.startsWith('<') ? thread.snippet : '';
    const heading = thread.heading || '';
    if (heading && snippet.startsWith(heading)) return 'Heading: ' + cut(heading, 60);
    if (heading && snippet) return cut(heading, 34) + ' › ' + cut(snippet, 34);
    if (heading) return cut(heading, 40) + (thread.block ? ' › ' + blockLabel(thread.block) : '');
    return snippet ? cut(snippet, 60) : (blockLabel(thread.block) || 'Part of the page');
  }

  function sizeLabel(thread) {
    if (!thread.device) return '';
    const width = parseInt(thread.viewport, 10);
    return SIZE_LABELS[thread.device] + (width ? ', ' + width + ' px' : '');
  }

  function renderFab() {
    const open = state.threads.filter(isTodo).length;
    fab.replaceChildren('Review', h('span', { class: 'n' }, open + ' open'));
    fab.hidden = state.panelOpen || state.commenting;
  }

  function renderHint() {
    hint.hidden = !(state.commenting && !state.panelOpen);
    if (hint.hidden) return;
    hint.replaceChildren(
      h('span', {}, 'Tap the part of the page you want to comment on.'),
      h('span', { class: 'row' },
        h('button', { class: 'solid', onclick: () => setCommenting(false) }, 'Cancel'),
        h('button', { onclick: () => openComposer(null) }, 'Whole page'),
      ),
    );
  }

  function setCommenting(on) {
    state.commenting = on;
    state.menuOpen = false;
    document.documentElement.classList.toggle('wprc-commenting', on);
    if (on) {
      closeComposer();
      // On phones the panel covers most of the page; get it out of the way.
      // Elsewhere comment mode shows at the top of the panel.
      if (window.innerWidth < 600) togglePanel(false);
      else if (!state.panelOpen) togglePanel(true);
      if (state.hovered) placeHighlight(state.hovered);
      // Ready before picking, so the page is copied before anything changes.
      loadScreenshotLibrary().catch(() => {});
    } else {
      restoreHighlight();
    }
    renderFab();
    renderHint();
    renderPanel();
  }

  function togglePanel(open = !state.panelOpen) {
    const opening = open && !state.panelOpen;
    state.panelOpen = open;
    if (!open) { state.editingId = null; state.menuOpen = false; }
    panel.hidden = !open;
    renderFab();
    renderHint();
    if (open) renderPanel();
    if (opening) loadSite().catch(() => {});
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
        onclick: () => openThread(thread.id),
        onmouseenter: () => markCard(thread.id, true),
        onmouseleave: () => markCard(thread.id, false),
      }, String(thread.n));
      pin.dataset.id = thread.id;
      return pin;
    }));
    positionPins();
  }

  function markCard(id, on) {
    const card = panel.querySelector('.card[data-id="' + id + '"]');
    if (card) card.classList.toggle('hl', on);
  }

  /** Hovering or focusing a card lifts its pin and outlines its element. */
  function hoverThread(id, on) {
    state.hoverId = on ? id : null;
    const pin = pinLayer.querySelector('.pin[data-id="' + id + '"]');
    if (pin) pin.classList.toggle('hl', on);
    if (state.commenting || state.composer) return;
    const thread = on && state.threads.find((t) => t.id === id);
    const el = thread && findElementCached(thread);
    if (el && visible(el)) placeHighlight(el);
    else restoreHighlight();
  }

  /** Outline the open thread's element, or nothing. */
  function restoreHighlight() {
    const thread = state.activeId && state.threads.find((t) => t.id === state.activeId);
    const el = thread && findElementCached(thread);
    if (el && visible(el)) placeHighlight(el);
    else highlight.hidden = true;
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
    // The outline follows its element while scrolling (and while the phone
    // keyboard scrolls the page).
    const outlined = (id) => { const t = state.threads.find((x) => x.id === id); return t && findElementCached(t); };
    if (state.composer && state.composerEl && state.composerEl.isConnected) placeHighlight(state.composerEl);
    else if (state.commenting && state.hovered && state.hovered.isConnected) placeHighlight(state.hovered);
    else if (state.hoverId && !highlight.hidden && outlined(state.hoverId)) placeHighlight(outlined(state.hoverId));
    else if (state.activeId && !highlight.hidden && !state.commenting && !state.composer && outlined(state.activeId)) placeHighlight(outlined(state.activeId));
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

  // --- panel ---------------------------------------------------------------

  function renderPanel() {
    if (!state.panelOpen) return;
    // Do not wipe what someone is typing; the next poll catches up.
    const focused = root.activeElement;
    if (focused && panel.contains(focused) && focused.tagName === 'TEXTAREA') return;
    const focusKey = focused && panel.contains(focused) ? focused.getAttribute('data-key') : null;
    const body = panel.querySelector('.p-body');
    const scroll = body ? body.scrollTop : 0;

    const list = numbered();
    let view;
    let kind;
    if (state.walk) {
      kind = 'walk-' + state.walk.index;
      view = renderWalk(list);
    } else if (state.detailId && list.some((t) => t.id === state.detailId)) {
      kind = 'detail-' + state.detailId;
      view = renderDetail(list.find((t) => t.id === state.detailId));
    } else {
      state.detailId = null;
      kind = 'list-' + state.scope;
      view = [renderHeader(list), h('div', { class: 'p-body' }, state.scope === 'site' ? renderSite() : renderList(list))];
    }
    panel.classList.toggle('picking', state.commenting);
    panel.replaceChildren(state.commenting ? renderPickbar() : '', ...view.filter(Boolean));

    const newBody = panel.querySelector('.p-body');
    if (newBody && panel.dataset.view === kind) newBody.scrollTop = scroll;
    panel.dataset.view = kind;
    // Keyboard focus survives the re-render.
    if (focusKey) {
      const again = panel.querySelector('[data-key="' + CSS.escape(focusKey) + '"]');
      if (again) again.focus();
    }
  }

  function renderPickbar() {
    return h('div', { class: 'pickbar', role: 'status' },
      h('b', {}, 'Click the part of the page you want to comment on'),
      h('span', {}, 'Or hover it and press Enter. Esc cancels.'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'solid', 'data-key': 'pick-cancel', onclick: () => setCommenting(false) }, 'Cancel'),
        h('button', { type: 'button', 'data-key': 'pick-page', onclick: () => openComposer(null) }, 'Comment on the whole page'),
      ),
    );
  }

  function renderMenu() {
    const close = () => { state.menuOpen = false; };
    return h('div', { class: 'menu' },
      h('button', {
        type: 'button', class: 'iconbtn', title: 'More', 'aria-label': 'More', 'aria-haspopup': 'menu', 'aria-expanded': String(state.menuOpen), 'data-key': 'more',
        onclick: () => { state.menuOpen = !state.menuOpen; renderPanel(); },
      }, icon('more')),
      state.menuOpen ? h('div', { class: 'menu-pop', role: 'menu' },
        h('p', { class: 'menu-who' }, 'Commenting as ' + whoAmI(), state.me.round ? h('br') : null, state.me.round ? 'Review round: ' + state.me.round : null),
        h('button', { type: 'button', role: 'menuitem', 'data-key': 'menu-general', onclick: () => { close(); openComposer(null); } },
          h('span', {}, 'General comment'), h('small', {}, 'Feedback about the whole page, not one part')),
        state.me.links ? h('a', { role: 'menuitem', href: state.me.links, target: '_blank', rel: 'noopener', 'data-key': 'menu-links', onclick: () => { close(); renderPanel(); } },
          h('span', {}, 'Make a review link'), h('small', {}, 'For guests without an account, in a new tab')) : null,
      ) : null,
    );
  }

  function renderHeader(list) {
    const pageTodo = list.filter(isTodo).length;
    const siteTodo = state.site ? state.site.filter(isTodo).length : null;
    const tab = (scope, label, n) => h('button', {
      type: 'button', 'aria-pressed': String(state.scope === scope), 'data-key': 'tab-' + scope,
      onclick: () => setScope(scope),
    }, label, n == null ? null : h('span', { class: 'n' }, String(n)));
    return h('header', { class: 'p-head' },
      h('div', { class: 'p-top' },
        h('h2', {}, 'Review'),
        h('span', { class: 'where', title: displayPath(pageUrl()) }, displayPath(pageUrl())),
        renderMenu(),
        h('button', { type: 'button', class: 'iconbtn', title: 'Close', 'aria-label': 'Close panel', 'data-key': 'close', onclick: () => togglePanel(false) }, icon('close')),
      ),
      h('button', {
        type: 'button', class: 'primary big', title: 'Comment on part of the page (shortcut: C)', 'data-key': 'comment',
        onclick: () => setCommenting(!state.commenting),
      }, state.commenting ? 'Cancel' : ['+ Comment', h('kbd', {}, 'C')]),
      h('div', { class: 'tabs', role: 'group', 'aria-label': 'Which comments' },
        tab('page', 'This page', pageTodo), tab('site', 'Whole site', siteTodo)),
      state.scope === 'page' && list.length ? renderFilters(list) : null,
    );
  }

  function setScope(scope) {
    state.scope = scope;
    if (scope === 'site') loadSite().catch(() => {});
    renderPanel();
  }

  function renderFilters(list) {
    const sized = list.filter(matchesSize);
    const chip = (key, label, pressed, onclick, n, extra) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(pressed), 'data-key': 'chip-' + key, onclick,
    }, extra || null, label, n == null ? null : h('span', { class: 'n' }, String(n)));
    const status = (value, label, n) => chip(value, label, state.statusFilter === value, () => { state.statusFilter = value; render(); }, n);
    const size = (value, label) => chip('size-' + (value || 'all'), label, state.sizeFilter === value, () => { state.sizeFilter = value; render(); }, null,
      value && value === device() ? h('span', { class: 'now', title: 'Your screen now' }) : null);
    // Sizes with comments, and the viewer's own.
    const sizes = SIZES.filter((s) => s === device() || s === state.sizeFilter || list.some((t) => t.device === s));
    return h('div', { class: 'filters' },
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Status' },
        status('todo', 'To do', sized.filter(isTodo).length),
        status('done', 'Resolved', sized.filter((t) => !isTodo(t)).length),
        status('all', 'All', sized.length)),
      h('span', { class: 'sep', 'aria-hidden': 'true' }),
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Screen size' },
        size('', 'All sizes'), sizes.map((s) => size(s, SIZE_LABELS[s]))),
    );
  }

  function renderList(list) {
    if (!list.length) {
      const elsewhere = state.site ? state.site.filter((t) => isTodo(t) && t.url !== pageUrl()).length : 0;
      return h('div', { class: 'empty' },
        h('b', {}, 'No comments on this page yet.'),
        h('span', {}, 'Press Comment, or the C key, then click the part of the page you want to talk about.'),
        elsewhere ? h('span', {}, elsewhere + ' open on other pages. ', h('button', { type: 'button', class: 'link', 'data-key': 'see-site', onclick: () => setScope('site') }, 'See the whole site')) : null,
      );
    }
    const items = list.filter(shown);
    if (!items.length) {
      return h('div', { class: 'empty' },
        h('b', {}, 'Nothing here'),
        h('span', {}, 'No comments on this page match these filters.'),
        h('span', {}, h('button', { type: 'button', class: 'link', 'data-key': 'show-all', onclick: () => { state.statusFilter = 'all'; state.sizeFilter = ''; render(); } }, 'Show all')),
      );
    }
    return items.map(renderCard);
  }

  function renderCard(thread) {
    const el = findElementCached(thread);
    const missing = !isPageComment(thread) && (!el || !visible(el));
    const replies = thread.replies.length;
    const card = h('button', {
      type: 'button', class: 'card' + (thread.id === state.activeId ? ' active' : ''), 'data-key': 'card-' + thread.id,
      onclick: () => openThread(thread.id),
      onmouseenter: () => hoverThread(thread.id, true),
      onmouseleave: () => hoverThread(thread.id, false),
      onfocus: () => hoverThread(thread.id, true),
      onblur: () => hoverThread(thread.id, false),
    },
      h('span', { class: 'num status-' + thread.status }, String(thread.n)),
      h('span', { class: 'c-main' },
        h('span', { class: 'c-meta' }, h('b', {}, thread.author), h('span', {}, timeAgo(thread.created))),
        h('span', { class: 'c-where' }, whereLabel(thread)),
        h('span', { class: 'c-text' + (thread.deleted ? ' deleted' : '') }, thread.deleted ? 'Comment deleted' : thread.text),
        h('span', { class: 'c-foot' },
          statusPill(thread.status),
          thread.device ? h('span', { class: thread.device !== device() ? 'other' : '' }, SIZE_LABELS[thread.device]) : null,
          replies ? h('span', {}, plural(replies, 'reply', 'replies')) : null,
          missing ? h('span', { class: 'warn', title: 'Not found or hidden at this screen size' }, 'Not visible here') : null,
        ),
      ),
    );
    card.dataset.id = thread.id;
    return card;
  }

  // --- whole site ------------------------------------------------------------

  let sitePromise = null;
  /** Every thread on the site (without replies), for the summary and going through. */
  function loadSite() {
    sitePromise ||= api('/threads')
      .then((all) => { state.site = all; state.siteError = null; renderPanel(); return all; })
      .catch((error) => { state.siteError = error.message; renderPanel(); throw error; })
      .finally(() => { sitePromise = null; });
    return sitePromise;
  }

  /** Keep the site summary in step with changes made on this page. */
  function syncSite(thread, removed) {
    if (!state.site) return;
    const index = state.site.findIndex((t) => t.id === (removed || thread.id));
    if (removed) { if (index !== -1) state.site.splice(index, 1); return; }
    const summary = {
      id: thread.id, url: thread.url || pageUrl(), page_title: thread.page_title, status: thread.status, device: thread.device,
      created: thread.created, author: thread.author, text: thread.text, activity: new Date().toISOString(),
    };
    if (index === -1) state.site.push(summary);
    else state.site[index] = { ...state.site[index], status: thread.status, text: thread.text, activity: summary.activity };
  }

  /** Threads grouped by page, most to do first. */
  function sitePages(all) {
    const pages = new Map();
    for (const t of all) {
      const page = pages.get(t.url) || { url: t.url, title: '', open: 0, in_progress: 0, done: 0, activity: '' };
      page.title ||= t.page_title;
      if (t.status === 'open') page.open++;
      else if (t.status === 'in_progress') page.in_progress++;
      else page.done++;
      const at = t.activity || t.created;
      if (at > page.activity) page.activity = at;
      pages.set(t.url, page);
    }
    return [...pages.values()].sort((a, b) => (b.open + b.in_progress) - (a.open + a.in_progress) || b.activity.localeCompare(a.activity));
  }

  function renderSite() {
    if (!state.site) return h('p', { class: 'empty' }, state.siteError || 'Loading…');
    if (!state.site.length) {
      return h('div', { class: 'empty' }, h('b', {}, 'No comments on the site yet.'), h('span', {}, 'Comments from every page show up here.'));
    }
    const pages = sitePages(state.site);
    const total = pages.reduce((sum, p) => ({ open: sum.open + p.open, in_progress: sum.in_progress + p.in_progress, done: sum.done + p.done }), { open: 0, in_progress: 0, done: 0 });
    const todo = total.open + total.in_progress;
    const stat = (n, label) => h('span', {}, h('b', {}, String(n)), label);
    const segment = (n, status) => (n ? h('i', { class: 'status-' + status, style: 'flex:' + n }) : null);
    return [
      h('div', { class: 'sum' },
        h('div', { class: 'sum-n' }, stat(total.open, 'open'), stat(total.in_progress, 'in progress'), stat(total.done, 'resolved')),
        h('div', { class: 'bar', role: 'img', 'aria-label': total.open + ' open, ' + total.in_progress + ' in progress, ' + total.done + ' resolved' },
          segment(total.open, 'open'), segment(total.in_progress, 'in_progress'), segment(total.done, 'resolved')),
        todo
          ? h('button', { type: 'button', class: 'primary go', 'data-key': 'go', title: 'One comment at a time, with ← and →', onclick: startWalkthrough }, 'Go through ' + todo + ' to do, page by page →')
          : h('p', { class: 'note' }, 'Nothing left to do on the site.'),
      ),
      h('div', { class: 'grp' }, 'By page, most to do first'),
      pages.map(renderPageRow),
    ];
  }

  function renderPageRow(page) {
    const here = page.url === pageUrl();
    const pill = (n, status, label) => (n ? h('span', { class: 'st st-' + status, title: n + ' ' + label }, String(n) + (status === 'open' ? ' open' : ''), status === 'open' ? null : h('span', { class: 'sr' }, ' ' + label)) : null);
    return h('button', {
      type: 'button', class: 'prow' + (here ? ' here' : ''), 'data-key': 'page-' + page.url,
      onclick: () => {
        if (here) { setScope('page'); return; }
        session.set(PANEL_KEY, 1);
        location.href = displayPath(page.url);
      },
    },
      h('span', { class: 'pr-main' },
        h('b', {}, shortTitle(page.title) || displayPath(page.url)),
        here ? h('span', { class: 'you' }, 'You are here') : null,
        h('span', { class: 'pr-path' }, displayPath(page.url) + ', last activity ' + timeAgo(page.activity)),
      ),
      h('span', { class: 'pr-counts' },
        pill(page.open, 'open', 'open'),
        pill(page.in_progress, 'in_progress', 'in progress'),
        page.done ? h('span', { class: 'pr-done', title: page.done + ' resolved' }, page.done + ' ✓', h('span', { class: 'sr' }, ' resolved')) : null,
      ),
    );
  }

  // --- one thread ------------------------------------------------------------

  function openThread(id) {
    focusThread(id);
  }

  function closeDetail() {
    state.detailId = null;
    state.activeId = null;
    highlight.hidden = true;
    if (/^#wprc-\d+$/.test(location.hash) && history.replaceState) history.replaceState(null, '', location.pathname + location.search);
    renderPins();
    renderPanel();
  }

  function statusControl(thread) {
    if (!state.me.is_editor) return statusPill(thread.status);
    return h('select', { class: 'status', 'aria-label': 'Status', 'data-key': 'status-' + thread.id, onchange: (e) => setStatus(thread.id, e.target.value) },
      Object.entries(STATUS_LABELS).map(([value, label]) => h('option', { value, selected: value === thread.status }, label)));
  }

  function renderDetail(thread) {
    return [
      h('div', { class: 'd-head' },
        h('button', { type: 'button', class: 'back', 'data-key': 'back', onclick: closeDetail }, '‹ All comments'),
        h('span', { class: 'num status-' + thread.status }, String(thread.n)),
        statusControl(thread),
      ),
      h('div', { class: 'p-body' }, renderThreadBody(thread, false)),
      renderReplyBox(thread, false),
    ];
  }

  function renderThreadBody(thread, walking) {
    const el = findElementCached(thread);
    const where = isPageComment(thread) ? '' : !el
      ? 'Not found at this screen size' + (thread.device ? ' (written on ' + thread.device + ')' : '')
      : !visible(el) ? 'Hidden right now: it may be in a menu, tab or slide that is closed' : '';
    return h('div', { class: 'd-body' },
      walking ? h('div', { class: 'c-meta' }, h('span', { class: 'num status-' + thread.status }, String(thread.n)), h('b', {}, thread.author), h('span', {}, timeAgo(thread.created)), statusControl(thread)) : null,
      thread.screenshot ? h('a', { class: 'shot', href: thread.screenshot, target: '_blank', rel: 'noopener', title: 'What the reviewer saw' },
        h('img', { src: thread.screenshot, alt: 'Screenshot when the comment was written', loading: 'lazy' })) : null,
      thread.screenshotFailed ? h('p', { class: 'note' }, thread.screenshotFailed === 'blocked'
        ? 'No screenshot: this browser blocked it. The comment itself is saved.'
        : 'The screenshot could not be saved. The comment itself is saved.') : null,
      h('div', { class: 'ctx' },
        h('span', {}, whereLabel(thread)),
        thread.device ? h('span', { title: 'Written at ' + thread.viewport }, sizeLabel(thread)) : null,
        thread.browser ? h('span', {}, browserLabel(thread.browser)) : null,
      ),
      where ? h('p', { class: 'detached' }, where + '. It was: “' + thread.snippet + '”') : null,
      walking ? h('div', { class: 'msg solo' }, renderBody(thread), ownActions(thread)) : renderMessage(thread),
      thread.replies.map(renderMessage),
    );
  }

  function renderMessage(comment) {
    const ai = comment.author_type === 'ai';
    return h('div', { class: 'msg' + (ai ? ' ai' : '') },
      h('span', { class: 'av' + (ai ? ' c' : ''), 'aria-hidden': 'true' }, initials(comment.author)),
      h('div', { class: 'm-main' },
        h('div', { class: 'c-meta' }, h('b', {}, comment.author), h('span', {}, timeAgo(comment.created)), ownActions(comment)),
        renderBody(comment),
      ),
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

  /** Reply box under a thread: the detail view's, or going through's. */
  function renderReplyBox(thread, walking) {
    const askName = !state.me.name && !store.get('name');
    const editor = state.me.is_editor;
    const button = (label, cls, then, key) => h('button', { type: 'button', class: cls, 'data-key': key, onclick: (e) => replyAction(thread.id, e.target.form, then) }, label);
    return h('form', { class: 'reply-box', onsubmit: (e) => { e.preventDefault(); replyAction(thread.id, e.target, 'reply'); } },
      h('label', { class: 'c-meta', for: 'wprc-reply' }, askName ? 'Reply' : 'Reply as ' + whoAmI()),
      askName ? guestNameFields(true) : null,
      h('textarea', {
        id: 'wprc-reply', rows: 2, placeholder: 'Reply…', 'aria-label': 'Reply', value: state.drafts[thread.id] || '',
        oninput: (e) => { state.drafts[thread.id] = e.target.value; },
        onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.target.form.requestSubmit(); },
      }),
      h('div', { class: 'row' }, walking
        ? [
          h('button', { type: 'button', class: 'ghost', 'data-key': 'skip', title: 'Next (→)', onclick: () => stepWalk(1) }, 'Skip'),
          h('button', { type: 'submit', class: editor ? 'ghost' : 'primary', 'data-key': 'reply' }, 'Reply'),
          editor ? button('Resolve and next', 'ok', 'resolve-next', 'resolve-next') : null,
        ]
        : [
          h('button', { type: 'button', class: 'ghost', 'data-key': 'copy', onclick: () => copyLink(thread) }, 'Copy link'),
          editor && isTodo(thread) ? button('Reply and resolve', 'ok', 'resolve', 'resolve') : null,
          h('button', { type: 'submit', class: 'primary', 'data-key': 'reply' }, 'Reply'),
        ]),
    );
  }

  async function copyLink(thread) {
    const link = thread.link || location.origin + displayPath(thread.url) + '#wprc-' + thread.id;
    try {
      await navigator.clipboard.writeText(link);
      showToast('Link copied.');
    } catch (e) {
      window.prompt('Copy this link', link);
    }
  }

  function focusThread(id, { scroll = true } = {}) {
    state.activeId = id;
    if (!state.walk) state.detailId = id;
    state.scope = 'page';
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
    state.composerEl = el;
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
    const nameFields = guestNameFields(askName);
    const asWho = !state.me.name && !askName ? h('p', { class: 'as' }, 'Commenting as ' + store.get('name') + ', ',
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
    // Space the open panel takes on the right.
    const panelWidth = state.panelOpen && window.innerWidth >= 600 ? panel.offsetWidth : 0;
    if (window.innerWidth < 600 || !el) {
      // Phones, and general comments: dock at the bottom, beside the panel
      // (on phones the keyboard then does not hide it).
      Object.assign(composerEl.style, { left: 'auto', right: panelWidth + 16 + 'px', top: 'auto', bottom: '64px' });
      if (window.innerWidth < 600) Object.assign(composerEl.style, { left: '12px', right: 'auto' });
    } else {
      Object.assign(composerEl.style, {
        left: Math.max(12, Math.min(point.x, window.innerWidth - panelWidth - width - 12)) + 'px',
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

  /** Name (and, when reply emails are on, email) fields for guests. */
  function guestNameFields(required) {
    const noAutofill = { autocomplete: 'off', 'data-1p-ignore': '', 'data-lpignore': 'true', 'data-form-type': 'other' };
    return h('div', { class: 'row' + (state.me.asks_email ? '' : ' single'), hidden: !required },
      h('input', { name: 'author_name', required, placeholder: 'Your name', value: store.get('name'), ...noAutofill }),
      state.me.asks_email ? h('input', { name: 'author_email', type: 'email', placeholder: 'Email for replies (optional)', title: 'Only used to email you when someone replies to this thread', value: store.get('email'), ...noAutofill }) : null,
    );
  }

  function closeComposer() {
    composerEl.hidden = true;
    state.composer = null;
    state.composerEl = null;
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
    // requestSubmit() fires even with the button disabled (held Cmd+Enter).
    if (!state.composer || form.dataset.busy) return;
    form.dataset.busy = '1';
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

  /** Disable a form while its request runs; requestSubmit() ignores disabled buttons. */
  async function busy(form, work) {
    if (form.dataset.busy) return;
    form.dataset.busy = '1';
    form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await work();
    } finally {
      delete form.dataset.busy;
      form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  }

  /**
   * Send what is in the reply box, then:
   * - 'reply': nothing more (an empty box sends nothing);
   * - 'resolve': resolve the thread, with or without a reply;
   * - 'resolve-next': resolve it and go on to the next one.
   */
  function replyAction(id, form, then) {
    const textarea = form.querySelector('textarea');
    const text = textarea.value.trim();
    if (!text && then === 'reply') { textarea.focus(); return; }
    return busy(form, async () => {
      try {
        if (text) {
          const thread = await api('/comments', {
            method: 'POST',
            body: JSON.stringify({ parent: id, text, ...guestFields(form) }),
          });
          delete state.drafts[id];
          textarea.value = '';
          textarea.blur();
          upsert(thread);
        }
        if (then !== 'reply') {
          upsert(await api('/comments/' + id + '/status', { method: 'POST', body: JSON.stringify({ status: 'resolved' }) }));
        }
        if (then === 'resolve-next') stepWalk(1);
      } catch (error) {
        showToast(error.message);
      }
    });
  }

  function saveEdit(id, form) {
    return busy(form, async () => {
      try {
        const thread = await api('/comments/' + id, { method: 'PUT', body: JSON.stringify({ text: form.querySelector('textarea').value }) });
        state.editingId = null;
        form.querySelector('textarea').blur();
        upsert(thread);
      } catch (error) {
        showToast(error.message);
      }
    });
  }

  async function removeComment(id) {
    if (!window.confirm('Delete this comment?')) return;
    try {
      const result = await api('/comments/' + id, { method: 'DELETE' });
      if (result.thread) upsert(result.thread);
      else {
        state.mutations++;
        const gone = result.removed || id;
        state.threads = state.threads.filter((t) => t.id !== gone);
        syncSite(null, gone);
        if (state.activeId === gone) { state.activeId = null; highlight.hidden = true; }
        if (state.detailId === gone) state.detailId = null;
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
    state.mutations++;
    const index = state.threads.findIndex((t) => t.id === thread.id);
    if (index === -1) state.threads.push(thread);
    else state.threads[index] = thread;
    syncSite(thread);
    render();
  }

  function render() {
    renderFab();
    renderHint();
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
    if (!canvasReadable()) throw Object.assign(new Error('This browser blocks reading canvases (fingerprinting protection)'), { blocked: true });
    const html2canvas = await loadScreenshotLibrary();
    const scale = Math.min(1, 1440 / view.width);
    // html2canvas copies the page into a viewport-sized iframe and scrolls it.
    // That scroll does not always take (always in WebKit, on some pages in
    // Chrome too), leaving all but the top of the copy blank, so the copy is
    // as tall as the page and nothing needs scrolling.
    const canvas = await html2canvas(document.documentElement, {
      ...view,
      windowWidth: document.documentElement.clientWidth,
      windowHeight: document.documentElement.scrollHeight,
      scale,
      useCORS: true,
      logging: false,
      backgroundColor: '#ffffff',
      ignoreElements: (node) => node === host,
      onclone: (doc) => {
        fixClone(doc);
        pinFixedElements(doc, view);
        onCopied();
      },
    });
    const ctx = canvas.getContext('2d');
    // html2canvas leaves the context scaled and shifted by the scroll offset.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (rect) {
      ctx.strokeStyle = '#3858e9';
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
   * In the page-tall copy, fixed elements (headers, cookie bars)
   * would sit at the top of the document. Put them where the reviewer saw
   * them: absolutely positioned at the current scroll offset.
   */
  function pinFixedElements(doc, view) {
    const originals = document.body.getElementsByTagName('*');
    const copies = doc.body.getElementsByTagName('*');
    if (originals.length !== copies.length) return;
    for (let i = 0; i < originals.length; i++) {
      const el = originals[i];
      if (el === host || host.contains(el)) continue;
      const position = getComputedStyle(el).position;
      if (position !== 'fixed' && position !== 'sticky') continue;
      const rect = el.getBoundingClientRect();
      Object.assign(copies[i].style, {
        position: 'absolute', top: (rect.top + view.y) + 'px', left: (rect.left + view.x) + 'px',
        width: rect.width + 'px', height: rect.height + 'px', right: 'auto', bottom: 'auto', margin: '0', transform: 'none',
      });
    }
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
      if (target) { target.screenshotFailed = error.blocked ? 'blocked' : 'failed'; renderPanel(); }
    }
  }

  // --- going through -------------------------------------------------------

  /**
   * Step through every thread still to do on the site, one at a time and page
   * by page: this page first, then the pages with the most to do. The list is
   * kept in sessionStorage, so it carries over as pages change.
   */
  async function startWalkthrough() {
    try {
      const all = await loadSite();
      const order = new Map(sitePages(all).map((page, i) => [page.url, page.url === pageUrl() ? -1 : i]));
      const items = all
        .filter(isTodo)
        .sort((a, b) => order.get(a.url) - order.get(b.url) || a.created.localeCompare(b.created))
        .map((t) => ({ id: t.id, url: t.url, title: shortTitle(t.page_title) }));
      if (!items.length) { showToast('Nothing left to do on the site.'); return; }
      state.walk = { items, index: 0 };
      session.set(WALK_KEY, state.walk);
      goToWalkItem();
    } catch (error) {
      showToast(error.message);
    }
  }

  function goToWalkItem() {
    const item = state.walk.items[state.walk.index];
    session.set(WALK_KEY, state.walk);
    if (item.url !== pageUrl()) {
      location.href = displayPath(item.url) + '#wprc-' + item.id;
      return;
    }
    if (state.threads.some((t) => t.id === item.id)) focusThread(item.id);
    else { togglePanel(true); renderPanel(); }
  }

  function stepWalk(delta) {
    if (!state.walk) return;
    const next = state.walk.index + delta;
    if (next < 0) return;
    if (next >= state.walk.items.length) {
      stopWalkthrough();
      showToast('That was the last one.');
      return;
    }
    state.walk.index = next;
    goToWalkItem();
  }

  function stopWalkthrough() {
    state.walk = null;
    session.set(WALK_KEY, null);
    state.scope = 'site';
    loadSite().catch(() => {});
    renderPanel();
  }

  function renderWalk(list) {
    const { items, index } = state.walk;
    const item = items[index];
    const samePage = items.filter((i) => i.url === item.url);
    const nextPage = items.slice(index + 1).find((i) => i.url !== item.url);
    const thread = item.url === pageUrl() ? list.find((t) => t.id === item.id) : null;
    const last = index === items.length - 1;
    return [
      h('div', { class: 'walk' },
        h('div', { class: 'walk-top' },
          h('b', {}, 'Going through'),
          h('span', { class: 'cnt' }, (index + 1) + ' of ' + items.length),
          h('button', { type: 'button', class: 'iconbtn', title: 'Stop going through', 'aria-label': 'Stop going through', 'data-key': 'walk-stop', onclick: stopWalkthrough }, icon('close')),
        ),
        h('div', { class: 'walk-prog', role: 'progressbar', 'aria-valuemin': '1', 'aria-valuemax': String(items.length), 'aria-valuenow': String(index + 1), 'aria-label': 'Progress' },
          h('i', { style: 'width:' + ((index + 1) / items.length) * 100 + '%' })),
        h('div', { class: 'walk-nav' },
          h('button', { type: 'button', class: 'ghost', title: 'Previous (←)', disabled: index === 0, 'data-key': 'walk-prev', onclick: () => stepWalk(-1) }, '← Previous'),
          h('span', { class: 'pg' },
            (item.title || displayPath(item.url)) + ', ' + (samePage.indexOf(item) + 1) + ' of ' + samePage.length + ' here',
            h('br'),
            nextPage ? 'next: ' + (nextPage.title || displayPath(nextPage.url)) : 'last page'),
          h('button', { type: 'button', class: 'primary', title: 'Next (→)', 'data-key': 'walk-next', onclick: () => stepWalk(1) }, last ? 'Finish' : 'Next →'),
        ),
      ),
      h('div', { class: 'p-body' }, thread
        ? renderThreadBody(thread, true)
        : h('div', { class: 'empty' }, h('b', {}, 'This comment is gone.'), h('span', {}, 'It was deleted or moved. Skip to the next one.'))),
      thread ? renderReplyBox(thread, true) : h('div', { class: 'reply-box' }, h('div', { class: 'row' },
        h('button', { type: 'button', class: 'primary', 'data-key': 'skip', onclick: () => stepWalk(1) }, 'Skip'))),
    ];
  }

  // --- page events ---------------------------------------------------------

  function pageTarget(event) {
    const el = event.target;
    return el && el !== host && el.nodeType === 1 && el !== document.documentElement && el !== document.body ? el : null;
  }

  /** Page listeners stay inert until the overlay has started for someone who may comment. */
  const active = () => !!(state.me && state.me.can_comment && host.isConnected);
  const fromOverlay = (event) => event.composedPath().includes(host);

  document.addEventListener('mousemove', (event) => {
    if (!active()) return;
    state.pointer = { x: event.clientX, y: event.clientY };
    const el = pageTarget(event);
    if (el) state.hovered = el;
    if (state.commenting && el) placeHighlight(el);
  }, true);

  // Capture phase, so links and buttons do not act while picking a spot.
  for (const type of ['click', 'pointerdown', 'mousedown', 'submit']) {
    document.addEventListener(type, (event) => {
      if (!active() || !state.commenting || fromOverlay(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (type === 'click') {
        const el = pageTarget(event);
        if (el) openComposer(el, { x: event.clientX, y: event.clientY });
      }
    }, true);
  }

  /** Keys the overlay handles do nothing else on the page. */
  const handled = (event) => { event.preventDefault(); event.stopPropagation(); };
  const composerText = () => (composerEl.querySelector('textarea') || {}).value || '';

  // Capture phase too: Enter must not activate the hovered link.
  document.addEventListener('keydown', (event) => {
    if (!active()) return;
    if (event.key === 'Escape') {
      if (state.commenting) {
        handled(event);
        setCommenting(false);
      } else if (state.composer && !composerText().trim()) {
        handled(event);
        closeComposer();
      } else if (state.menuOpen) {
        handled(event);
        state.menuOpen = false;
        renderPanel();
      } else if (state.panelOpen && state.detailId && !state.walk && !isTyping(event)) {
        handled(event);
        closeDetail();
      }
      return;
    }
    if (isTyping(event) || event.metaKey || event.ctrlKey || event.altKey) return;
    // Enter on a focused overlay button presses that button.
    if (state.commenting && event.key === 'Enter' && !fromOverlay(event) && state.hovered && state.hovered.isConnected) {
      handled(event);
      openComposer(state.hovered, state.pointer);
    } else if ((event.key === 'c' || event.key === 'C') && !(state.composer && composerText().trim())) {
      // Opening a dropdown first and then pressing C keeps it open, unlike
      // clicking the button, which counts as a click outside the menu. A
      // composer with text in it is never thrown away by a stray C.
      handled(event);
      setCommenting(!state.commenting);
    } else if (state.walk && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
      handled(event);
      stepWalk(event.key === 'ArrowRight' ? 1 : -1);
    }
  }, true);

  let frame = 0;
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(positionPins); };
  window.addEventListener('scroll', () => { if (active()) schedule(); }, { passive: true, capture: true });
  let lastDevice = device();
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (!active()) return;
    // Mobile browsers fire resize while scrolling (the address bar); only a
    // width change can move elements around.
    if (window.innerWidth !== lastWidth) {
      lastWidth = window.innerWidth;
      elementCache.clear();
    }
    schedule();
    if (device() !== lastDevice) { lastDevice = device(); render(); }
  });

  window.addEventListener('hashchange', () => {
    if (!active()) return;
    const match = location.hash.match(/^#wprc-(\d+)$/);
    if (match) focusThread(Number(match[1]));
  });

  // --- boot ----------------------------------------------------------------

  let loadSeq = 0;
  async function load() {
    const seq = ++loadSeq;
    const mutationsBefore = state.mutations;
    const threads = await api('/comments?url=' + encodeURIComponent(pageUrl()));
    // A newer load, or a change made while this one was in flight, wins.
    if (seq !== loadSeq || state.mutations !== mutationsBefore) return;
    state.threads = threads;
    elementCache.clear();
    render();
  }

  const canRefresh = () => document.visibilityState === 'visible' && !state.composer && !panel.querySelector('.edit-form');

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
    if (boot && boot.page) state.pageKey = boot.page;
    if (!state.me.can_comment) {
      // A revoked or expired round: stop loading the overlay on every page.
      document.cookie = 'wprc_on=; Max-Age=0; path=/';
    }
    if (!state.me.can_comment) return;

    document.body.append(host);
    document.head.append(h('style', {}, 'html.wprc-commenting, html.wprc-commenting * { cursor: crosshair !important; }'));
    renderFab();
    if (boot && Array.isArray(boot.threads)) {
      state.threads = boot.threads;
      render();
    } else {
      await load();
    }

    const walk = session.get(WALK_KEY);
    state.walk = walk && Array.isArray(walk.items) && walk.items[walk.index] ? walk : null;
    if (!state.walk) session.set(WALK_KEY, null);
    const fromSummary = session.get(PANEL_KEY);
    session.set(PANEL_KEY, null);
    const match = location.hash.match(/^#wprc-(\d+)$/);
    if (state.walk) {
      togglePanel(true);
      const item = state.walk.items[state.walk.index];
      if (item.url === pageUrl()) setTimeout(() => focusThread(item.id), 300);
    } else if (match) {
      setTimeout(() => focusThread(Number(match[1])), 300);
    } else if (token || fromSummary) {
      togglePanel(true);
    }

    const refresh = () => {
      if (!canRefresh()) return;
      load().catch(() => {});
      if (state.panelOpen) loadSite().catch(() => {});
    };
    setInterval(refresh, POLL_MS);
    document.addEventListener('visibilitychange', refresh);
    // Late layout shifts (fonts, images, sliders) move elements after load.
    window.addEventListener('load', () => { elementCache.clear(); positionPins(); });
  }

  boot().catch((error) => console.warn('[wprc]', error));

  function CSS_TEXT() {
    return `
      :host {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
        --ink: #1e1e1e; --muted: #6b6b73; --line: #e3e3e8; --soft: #f5f5f7;
        --accent: #3858e9; --accent-soft: #eef1fd;
        --open: #3858e9; --open-bg: #eef1fd; --prog: #b26200; --prog-bg: #fff3e0; --done: #1f7a3d; --done-bg: #e6f5ea; --wontfix: #6b6b73; --wontfix-bg: #f0f0f2;
      }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; }
      [hidden] { display: none !important; }
      button { font: inherit; color: inherit; cursor: pointer; }
      button:disabled { opacity: .4; cursor: default; }
      :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
      .icon { display: grid; place-items: center; }

      /* On the page */
      .highlight { position: fixed; pointer-events: none; outline: 2px solid var(--accent); outline-offset: 2px; background: rgba(56,88,233,.08); border-radius: 2px; transition: all .08s; }
      .pin { position: fixed; width: 28px; height: 28px; margin: -14px 0 0 -14px; border-radius: 50% 50% 50% 4px; border: 2px solid #fff; background: var(--open); color: #fff; font-size: 12px; font-weight: 700; box-shadow: 0 2px 8px rgba(0,0,0,.3); padding: 0; transition: transform .1s; }
      .pin.active, .pin.hl { transform: scale(1.25); z-index: 1; }
      .pin.active { box-shadow: 0 0 0 3px var(--ink), 0 2px 8px rgba(0,0,0,.3); }
      .pin.other-device { opacity: .55; border-style: dashed; }
      .pin.status-in_progress, .num.status-in_progress, .bar .status-in_progress { background: var(--prog); }
      .pin.status-resolved, .num.status-resolved, .bar .status-resolved { background: var(--done); }
      .pin.status-wontfix, .num.status-wontfix { background: var(--wontfix); }
      .bar .status-open { background: var(--open); }
      .fab { position: fixed; right: 16px; bottom: 16px; display: inline-flex; align-items: center; gap: 8px; background: var(--ink); color: #fff; border: 0; border-radius: 999px; padding: 9px 14px; font-size: 14px; font-weight: 600; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
      .fab .n { background: var(--accent); border-radius: 999px; padding: 0 7px; font-size: 12px; line-height: 20px; }
      .fab:focus-visible { outline-color: var(--accent); outline-offset: 3px; }
      .hint { position: fixed; left: 12px; right: 12px; bottom: 12px; display: grid; gap: 8px; background: var(--accent); color: #fff; padding: 10px 12px; border-radius: 10px; font-size: 13px; box-shadow: 0 6px 24px rgba(0,0,0,.25); }
      .hint .row, .pickbar .row { display: flex; gap: 8px; flex-wrap: wrap; }
      .hint button, .pickbar button { border: 1px solid rgba(255,255,255,.6); background: transparent; color: #fff; border-radius: 6px; padding: 5px 10px; font-size: 13px; font-weight: 600; }
      .hint button.solid, .pickbar button.solid { background: #fff; color: var(--accent); border-color: #fff; }
      .hint :focus-visible, .pickbar :focus-visible { outline-color: #fff; }
      .toast { position: fixed; left: 50%; bottom: 72px; transform: translateX(-50%); background: var(--ink); color: #fff; padding: 10px 16px; border-radius: 8px; font-size: 14px; max-width: calc(100vw - 32px); }

      /* Panel */
      .panel { position: fixed; top: 0; right: 0; bottom: 0; width: 380px; max-width: 100%; background: #fff; color: var(--ink); border-left: 1px solid var(--line); box-shadow: -8px 0 32px rgba(0,0,0,.14); display: flex; flex-direction: column; font-size: 13.5px; line-height: 1.45; }
      .panel.picking > :not(.pickbar) { opacity: .45; pointer-events: none; }
      .pickbar { display: grid; gap: 4px; padding: 12px 16px; background: var(--accent); color: #fff; }
      .pickbar b { font-size: 14px; }
      .pickbar .row { margin-top: 6px; }
      .p-head { padding: 14px 16px 12px; border-bottom: 1px solid var(--line); display: grid; gap: 10px; }
      .p-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .p-top h2 { margin: 0; font-size: 15px; font-weight: 700; }
      .p-top .where { color: var(--muted); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; }
      .iconbtn { border: 0; background: transparent; width: 30px; height: 30px; border-radius: 6px; display: grid; place-items: center; color: var(--muted); padding: 0; flex: none; }
      .iconbtn:hover { background: var(--soft); color: var(--ink); }
      .menu { position: relative; }
      .menu-pop { position: absolute; right: 0; top: 34px; z-index: 5; background: #fff; border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.14); padding: 6px; display: grid; min-width: 250px; }
      .menu-pop button, .menu-pop a { border: 0; background: transparent; text-align: left; padding: 8px 10px; border-radius: 5px; display: grid; color: var(--ink); text-decoration: none; font-size: 13.5px; }
      .menu-pop button:hover, .menu-pop a:hover { background: var(--soft); }
      .menu-pop small { color: var(--muted); font-size: 12px; }
      .menu-who { margin: 0 0 4px; padding: 6px 10px 8px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 12px; }
      .primary { border: 0; background: var(--accent); color: #fff; border-radius: 7px; padding: 7px 12px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
      .primary.big { padding: 9px 12px; }
      .primary:focus-visible, .ok:focus-visible { outline-offset: 2px; }
      .primary kbd { background: rgba(255,255,255,.22); border-radius: 3px; padding: 0 5px; font: 600 11.5px/18px inherit; font-family: inherit; }
      .ghost { border: 1px solid #c9c9d0; background: #fff; border-radius: 7px; padding: 7px 12px; font-weight: 600; }
      .ok { border: 0; background: var(--done); color: #fff; border-radius: 7px; padding: 7px 12px; font-weight: 600; }
      .tabs { display: grid; grid-template-columns: 1fr 1fr; background: var(--soft); border-radius: 7px; padding: 3px; }
      .tabs button { border: 0; background: transparent; border-radius: 5px; padding: 5px; font-weight: 600; color: var(--muted); }
      .tabs button[aria-pressed="true"] { background: #fff; color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,.1); }
      .tabs .n { color: var(--muted); font-weight: 500; margin-left: 5px; }
      .filters, .chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
      .filters .sep { width: 1px; height: 18px; background: var(--line); margin: 0 2px; }
      .chip { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line); background: #fff; border-radius: 999px; padding: 3px 10px; font-size: 12.5px; font-weight: 600; color: #4a4a52; }
      .chip[aria-pressed="true"] { border-color: var(--ink); background: var(--ink); color: #fff; }
      .chip .n { font-weight: 500; opacity: .7; }
      .chip .now { width: 6px; height: 6px; border-radius: 50%; background: #1f9d4c; }
      .p-body { flex: 1; overflow: auto; min-height: 0; overscroll-behavior: contain; }
      .grp { padding: 12px 16px 6px; font-size: 11.5px; font-weight: 700; color: var(--muted); letter-spacing: .04em; text-transform: uppercase; }
      .empty { padding: 28px 18px; margin: 0; color: var(--muted); display: grid; gap: 6px; text-align: center; }
      .empty b { color: var(--ink); }
      .link { border: 0; background: none; padding: 0; color: var(--accent); font-size: inherit; font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
      .link.danger { color: #b91c1c; }

      /* Thread cards */
      .card { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 10px; width: 100%; padding: 12px 16px; border: 0; border-bottom: 1px solid var(--line); background: transparent; text-align: left; font-size: 13.5px; line-height: 1.45; }
      .card:hover, .card.hl { background: var(--accent-soft); }
      .card.active { box-shadow: inset 3px 0 0 var(--accent); }
      .card:focus-visible { outline-offset: -2px; }
      .card > .c-main { display: grid; min-width: 0; }
      .num { width: 24px; height: 24px; border-radius: 50% 50% 50% 4px; background: var(--open); color: #fff; font-weight: 700; font-size: 12px; display: inline-grid; place-items: center; flex: none; }
      .c-meta { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); min-width: 0; flex-wrap: wrap; }
      .c-meta b { color: var(--ink); font-size: 13px; }
      .c-where { font-size: 12px; color: var(--accent); font-weight: 600; margin: 2px 0 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .c-text { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
      .c-text.deleted { color: #a1a1aa; font-style: italic; }
      .c-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; font-size: 12px; color: var(--muted); }
      .c-foot .other { color: #92400e; }
      .c-foot .warn { color: #b45309; }
      .st { border-radius: 999px; padding: 0 7px; font-size: 11.5px; font-weight: 700; line-height: 18px; white-space: nowrap; }
      .st-open { background: var(--open-bg); color: var(--open); }
      .st-in_progress { background: var(--prog-bg); color: var(--prog); }
      .st-resolved { background: var(--done-bg); color: var(--done); }
      .st-wontfix { background: var(--wontfix-bg); color: var(--wontfix); }

      /* Whole site */
      .sum { padding: 14px 16px; border-bottom: 1px solid var(--line); display: grid; gap: 10px; }
      .sum-n { display: flex; gap: 18px; }
      .sum-n span { display: grid; font-size: 12px; color: var(--muted); }
      .sum-n b { font-size: 22px; color: var(--ink); line-height: 1.1; }
      .bar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; gap: 2px; background: var(--line); }
      .go { width: 100%; padding: 9px 12px; }
      .note { margin: 0; font-size: 12px; color: var(--muted); }
      .prow { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; width: 100%; text-align: left; background: transparent; border: 0; border-bottom: 1px solid var(--line); padding: 11px 16px; font-size: 13.5px; }
      .prow:hover { background: var(--accent-soft); }
      .prow:focus-visible { outline-offset: -2px; }
      .prow.here { box-shadow: inset 3px 0 0 var(--accent); }
      .pr-main { display: grid; min-width: 0; }
      .pr-main b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pr-path { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .you { font-size: 11px; font-weight: 700; color: var(--accent); }
      .pr-counts { display: flex; gap: 4px; align-items: center; }
      .pr-done { font-size: 12px; color: var(--done); font-weight: 600; margin-left: 2px; white-space: nowrap; }

      /* One thread */
      .d-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
      .d-head .back { border: 0; background: transparent; color: var(--accent); font-weight: 600; padding: 0; margin-right: auto; }
      select.status { font: inherit; font-size: 12.5px; font-weight: 600; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--ink); }
      .d-body { padding: 14px 16px; display: grid; gap: 14px; }
      .d-body > .c-meta select.status { margin-left: auto; }
      .shot { display: block; }
      .shot img { display: block; width: 100%; max-height: 180px; object-fit: cover; object-position: top; border-radius: 6px; border: 1px solid var(--line); }
      .ctx { font-size: 12px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 4px 10px; }
      .detached { margin: 0; font-size: 12px; color: #b45309; }
      .msg { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 10px; }
      .msg.solo { grid-template-columns: minmax(0, 1fr); gap: 4px; }
      .av { width: 28px; height: 28px; border-radius: 50%; background: #dfe4fb; color: var(--accent); font-weight: 700; font-size: 11.5px; display: grid; place-items: center; }
      .av.c { background: #ede4fe; color: #6d28d9; }
      .text { margin: 2px 0 0; white-space: pre-wrap; word-break: break-word; }
      .text.deleted { color: #a1a1aa; font-style: italic; }
      .edited { color: #a1a1aa; font-size: 12px; }
      .own { display: inline-flex; gap: 10px; margin-left: auto; }
      .own .link { font-size: 12px; font-weight: 500; }
      .edit-form { display: grid; gap: 6px; margin-top: 6px; }
      .reply-box { border-top: 1px solid var(--line); padding: 12px 16px; display: grid; gap: 8px; }
      .reply-box .row:last-child, .actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
      .actions button { border: 1px solid #c9c9d0; background: #fff; border-radius: 7px; padding: 6px 12px; font-size: 13px; font-weight: 600; }
      .actions button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }

      /* Going through */
      .walk { display: grid; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--soft); }
      .walk-top { display: flex; align-items: center; gap: 8px; }
      .walk-top b { font-size: 14px; }
      .walk-top .cnt { margin-left: auto; color: var(--muted); font-weight: 600; font-variant-numeric: tabular-nums; }
      .walk-prog { height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
      .walk-prog i { display: block; height: 100%; background: var(--accent); }
      .walk-nav { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: center; }
      .walk-nav .pg { font-size: 12px; color: var(--muted); text-align: center; overflow: hidden; text-overflow: ellipsis; }

      /* Forms */
      textarea, input[type=text], input:not([type]), input[type=email] { font: inherit; font-size: 16px; width: 100%; padding: 8px 10px; border: 1px solid #c9c9d0; border-radius: 7px; color: var(--ink); background: #fff; resize: vertical; }
      .reply-box textarea { font-size: 14px; min-height: 56px; }
      textarea:focus, input:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
      .composer { position: fixed; background: #fff; color: var(--ink); padding: 12px; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.25); font-size: 14px; }
      .composer form { display: grid; gap: 8px; }
      .target { margin: 0; font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .as { margin: 0; font-size: 12px; color: var(--muted); }
      .row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      .row.single { grid-template-columns: 1fr; }

      @media (max-width: 600px) {
        .panel { top: auto; left: 0; right: 0; width: auto; height: 70vh; border-left: 0; border-radius: 14px 14px 0 0; }
        .row { grid-template-columns: 1fr; }
        .reply-box textarea { font-size: 16px; min-height: 44px; }
        .reply-box { padding: 10px 16px; gap: 6px; }
        .reply-box > label { display: none; }
        .walk { gap: 8px; padding: 10px 16px; }
        .shot img { max-height: 110px; }
        .d-body { gap: 10px; }
      }
    `;
  }
})();
