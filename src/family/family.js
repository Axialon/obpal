/*
 * Blackboxes family: shared behaviour for ecosystem.blackboxes.net, the nine engines and ob.Pal.
 * A dependency-free classic script (works inlined or imported). Exposes window.BlackboxesFamily.
 *
 *   theme    surface choice, remembered across every *.blackboxes.net site (a parent-domain cookie)
 *   product  identity accent; never changed by the theme
 *   mark     the obsidian cube lit in the product's colour (ob.Pal keeps its orbit)
 *   menus    product switcher, theme picker and the "More" overflow for secondary tools
 *   tips     hover tooltips for [data-tip]; hints: coach marks that stay dismissed for the session
 */
(function (global) {
  'use strict';
  if (global.BlackboxesFamily) return;
  var doc = global.document;

  var PRODUCTS = [
    { id: 'ecosystem', name: 'Blackboxes', category: 'The ecosystem', host: 'ecosystem.blackboxes.net', accent: '#7dd3fc' },
    { id: 'boxem', name: "Box'em", category: 'Projects & planning', host: 'boxem.blackboxes.net', accent: '#38bdf8' },
    { id: 'orbitem', name: "Orbit'em", category: 'Cloud architecture', host: 'orbitem.blackboxes.net', accent: '#22d3ee' },
    { id: 'pulseem', name: "Pulse'em", category: 'Training & recovery', host: 'pulseem.blackboxes.net', accent: '#fb7185' },
    { id: 'capem', name: "Cap'em", category: 'Ownership & runway', host: 'capem.blackboxes.net', accent: '#fcd34d' },
    { id: 'synthem', name: "Synth'em", category: 'Sound design', host: 'synthem.blackboxes.net', accent: '#f0abfc' },
    { id: 'balancem', name: "Balanc'em", category: 'Resource balance', host: 'balancem.blackboxes.net', accent: '#6ee7b7' },
    { id: 'printem', name: "Print'em", category: 'Making & printing', host: 'printem.blackboxes.net', accent: '#ffa866' },
    { id: 'wattem', name: "Watt'em", category: 'Energy', host: 'wattem.blackboxes.net', accent: '#7be2ae' },
    { id: 'reachem', name: "Reach'em", category: 'Growth & reach', host: 'reachem.blackboxes.net', accent: '#ff9b99' },
    { id: 'obpal', name: 'ob.Pal', category: 'Phone as a 3D remote', host: 'obpal.blackboxes.net', accent: '#c6ff34' }
  ];
  var THEMES = [
    { id: 'carbon', name: 'Carbon', page: '#0b0b0c', surface: '#1e1e20', light: false },
    { id: 'navy', name: 'Navy', page: '#070d17', surface: '#111d32', light: false },
    { id: 'violet', name: 'Violet', page: '#0c0717', surface: '#36255c', light: false },
    { id: 'wine', name: 'Wine ash', page: '#110c0f', surface: '#32292f', light: false },
    { id: 'onyx', name: 'Onyx', page: '#020202', surface: '#10151a', light: false },
    { id: 'light', name: 'Light', page: '#eef1f6', surface: '#ffffff', light: true }
  ];
  var ACCENTS = [
    { id: 'product', name: 'Product colour' },
    { id: 'lime', name: 'Lime', color: '#c6ff34' }, { id: 'lavender', name: 'Lavender', color: '#d2c3f6' },
    { id: 'turquoise', name: 'Turquoise', color: '#99e1d9' }, { id: 'candy', name: 'Candy blue', color: '#b2d5e5' },
    { id: 'sky', name: 'Sky', color: '#38bdf8' }, { id: 'rose', name: 'Rose', color: '#fb7185' },
    { id: 'amber', name: 'Amber', color: '#fcd34d' }, { id: 'mint', name: 'Mint', color: '#6ee7b7' }
  ];
  var DEFAULT_THEME = 'carbon';
  var KEY = 'bb_theme';
  var ACCENT_KEY = 'bb_accent';
  var byId = function (list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); };
  var store = {
    get: function (k) { try { return global.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { global.localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    sget: function (k) { try { return global.sessionStorage.getItem(k); } catch (e) { return null; } },
    sset: function (k, v) { try { global.sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  };

  // ---- theme ------------------------------------------------------------------------------------------------

  /** Registrable parent domain for the shared cookie (blackboxes.net or blackboxes.dev), or null elsewhere. */
  function parentDomain() {
    var h = global.location && global.location.hostname || '';
    var m = /(?:^|\.)(blackboxes\.(?:net|dev))$/.exec(h);
    return m ? m[1] : null;
  }
  function readCookie() {
    var m = /(?:^|;\s*)bb_theme=([a-z]+)/.exec(doc.cookie || '');
    return m ? m[1] : null;
  }
  function getTheme() {
    var t = readCookie() || store.get(KEY);
    return byId(THEMES, t) ? t : DEFAULT_THEME;
  }
  function applyTheme(id) {
    var t = byId(THEMES, id) ? id : getTheme();
    doc.documentElement.setAttribute('data-bb-theme', t);
    var meta = doc.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', byId(THEMES, t).page);
    return t;
  }
  function setTheme(id) {
    if (!byId(THEMES, id)) return getTheme();
    var d = parentDomain();
    var secure = global.location && global.location.protocol === 'https:' ? '; Secure' : '';
    doc.cookie = KEY + '=' + id + '; Max-Age=31536000; Path=/; SameSite=Lax' + (d ? '; Domain=.' + d : '') + secure;
    store.set(KEY, id);
    var prev = doc.documentElement.getAttribute('data-bb-theme');
    applyTheme(id);
    if (prev !== id) global.dispatchEvent(new CustomEvent('bb-theme', { detail: { theme: id } }));
    return id;
  }
  // A theme picked on another *.blackboxes.net tab applies when this one regains focus.
  function watchTheme() {
    var sync = function () {
      var t = getTheme();
      if (t !== doc.documentElement.getAttribute('data-bb-theme')) { applyTheme(t); global.dispatchEvent(new CustomEvent('bb-theme', { detail: { theme: t } })); }
    };
    global.addEventListener('focus', sync);
    doc.addEventListener('visibilitychange', function () { if (!doc.hidden) sync(); });
    global.addEventListener('storage', function (e) { if (e.key === KEY) sync(); });
  }
  function setProduct(id) {
    if (byId(PRODUCTS, id)) doc.documentElement.setAttribute('data-bb-product', id);
  }
  function product() {
    return byId(PRODUCTS, doc.documentElement.getAttribute('data-bb-product')) || PRODUCTS[0];
  }

  // ---- accent (per site: each product keeps its own colour unless the visitor picks another here) ----------

  function getAccent() {
    var a = store.get(ACCENT_KEY);
    return a && byId(ACCENTS, a) ? a : 'product';
  }
  function applyAccent(id) {
    var a = id && byId(ACCENTS, id) ? id : getAccent();
    if (a === 'product') doc.documentElement.removeAttribute('data-bb-accent');
    else doc.documentElement.setAttribute('data-bb-accent', a);
    return a;
  }
  function setAccent(id) {
    if (!byId(ACCENTS, id)) return getAccent();
    var prev = getAccent();
    if (id === 'product') { try { global.localStorage.removeItem(ACCENT_KEY); } catch (e) { /* private mode */ } } else store.set(ACCENT_KEY, id);
    applyAccent(id);
    if (prev !== id) global.dispatchEvent(new CustomEvent('bb-accent', { detail: { accent: id } }));
    return id;
  }
  /** The accent in effect as a hex colour (the product colour unless overridden). */
  function accentColor() {
    var a = byId(ACCENTS, getAccent());
    return a && a.color ? a.color : product().accent;
  }

  // ---- mark -------------------------------------------------------------------------------------------------

  var markSeq = 0;
  /**
   * The family mark: an obsidian isometric cube whose lower faces and front edges catch the product's light.
   * ob.Pal adds its orbit ring and satellite (behind and in front of the cube). Returns an SVG string.
   * opts.accent overrides the colour (e.g. 'currentColor' is not supported; pass a hex).
   */
  function mark(productId, opts) {
    opts = opts || {};
    var p = byId(PRODUCTS, productId) || PRODUCTS[0];
    var a = opts.accent || p.accent;
    var id = 'bbm' + (++markSeq);
    var orbit = p.id === 'obpal';
    var title = opts.title === false ? '' : '<title>' + esc(p.name) + '</title>';
    var ring = orbit
      ? '<ellipse cx="50" cy="57" rx="47" ry="15" transform="rotate(-14 50 57)" fill="none" stroke="' + a + '" stroke-width="3" opacity=".32"/>'
      : '';
    var front = orbit
      ? '<path d="M95.6 45.63 A47 15 -14 0 1 4.4 68.37" fill="none" stroke="' + a + '" stroke-width="3.8" stroke-linecap="round"/>' +
        '<circle cx="82.1" cy="60.8" r="4.8" fill="' + a + '"/><circle cx="82.1" cy="60.8" r="1.8" fill="#fff"/>'
      : '';
    // Engines fill the frame: the cube is scaled up a little when there's no ring around it.
    var g = orbit ? '<g>' : '<g transform="translate(50 50) scale(1.16) translate(-50 -49.8)">';
    return '<svg class="bb-mark" viewBox="0 0 100 100" role="img" aria-label="' + esc(p.name) + '" shape-rendering="geometricPrecision">' + title +
      '<defs>' +
      '<linearGradient id="' + id + 't" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#565656"/><stop offset=".35" stop-color="#2a2a2a"/><stop offset=".75" stop-color="#141414"/><stop offset="1" stop-color="#050505"/></linearGradient>' +
      '<linearGradient id="' + id + 'l" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d1d1d"/><stop offset=".45" stop-color="#0a0a0a"/><stop offset="1" stop-color="#000"/></linearGradient>' +
      '<linearGradient id="' + id + 'r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#313131"/><stop offset=".5" stop-color="#141414"/><stop offset="1" stop-color="#050505"/></linearGradient>' +
      '<linearGradient id="' + id + 's" x1="0" y1="0" x2="0" y2="1"><stop offset=".42" stop-color="' + a + '" stop-opacity="0"/><stop offset="1" stop-color="' + a + '" stop-opacity=".5"/></linearGradient>' +
      '</defs>' + ring + g +
      '<polygon points="50,19 78,34.4 78,65.2 50,80.6 22,65.2 22,34.4" fill="#000"/>' +
      '<polygon points="50,19 78,34.4 50,49.8 22,34.4" fill="url(#' + id + 't)"/>' +
      '<polygon points="22,34.4 50,49.8 50,80.6 22,65.2" fill="url(#' + id + 'l)"/>' +
      '<polygon points="50,49.8 78,34.4 78,65.2 50,80.6" fill="url(#' + id + 'r)"/>' +
      '<polygon points="22,34.4 50,49.8 50,80.6 22,65.2" fill="url(#' + id + 's)" opacity=".7"/>' +
      '<polygon points="50,49.8 78,34.4 78,65.2 50,80.6" fill="url(#' + id + 's)"/>' +
      '<polygon points="50,19 78,34.4 78,65.2 50,80.6 22,65.2 22,34.4" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="1.3" stroke-linejoin="round"/>' +
      '<path d="M50,49.8 L50,80.6" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="1.3"/>' +
      '<path d="M22,34.4 L50,49.8 L78,34.4" fill="none" stroke="' + a + '" stroke-width="2.4" stroke-linejoin="round"/>' +
      '<line x1="50" y1="19" x2="78" y2="34.4" stroke="rgba(255,255,255,.72)" stroke-width="1.3"/>' +
      '<line x1="50" y1="19" x2="78" y2="34.4" stroke="' + a + '" stroke-width="1.4" opacity=".55"/>' +
      '</g>' + front + '</svg>';
  }

  // ---- menus ------------------------------------------------------------------------------------------------

  var ICON = {
    chevron: '<svg class="bb-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    check: '<svg class="bb-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>'
  };
  var rgbOf = function (hex) { var n = parseInt(hex.slice(1), 16); return ((n >> 16) & 255) + ' ' + ((n >> 8) & 255) + ' ' + (n & 255); };

  /** Menu items linking to every product's home, current one marked. */
  function productMenu(current) {
    return PRODUCTS.map(function (p, i) {
      var sep = i === 1 ? '<div class="bb-label bb-menu-group">Engines</div>' : i === PRODUCTS.length - 1 ? '<div class="bb-label bb-menu-group">Tools</div>' : '';
      return sep + '<a class="bb-menu-item" role="menuitem" href="https://' + p.host + '/" style="--bb-item-rgb:' + rgbOf(p.accent) + '"' + (p.id === current ? ' aria-current="page"' : '') + '>' +
        mark(p.id, { title: false }) + '<span><b style="color:' + p.accent + '">' + esc(p.name) + '</b><small>' + esc(p.category) + '</small></span></a>';
    }).join('');
  }
  function themeMenu() {
    var cur = getTheme(), acc = getAccent(), own = product().accent;
    return '<div class="bb-label bb-menu-group">Surface</div>' +
      '<div class="bb-themes" role="radiogroup" aria-label="Surface">' + THEMES.map(function (t) {
        return '<button type="button" class="bb-theme" role="radio" data-bb-theme-id="' + t.id + '" aria-checked="' + (t.id === cur) + '"><i style="background:linear-gradient(135deg,' + t.surface + ',' + t.page + ')"></i>' + esc(t.name) + '</button>';
      }).join('') + '</div>' +
      '<div class="bb-label bb-menu-group">Accent</div>' +
      '<div class="bb-accents" role="radiogroup" aria-label="Accent">' + ACCENTS.filter(function (a) {
        return !a.color || a.color.toLowerCase() !== own.toLowerCase() || a.id === acc; // the product colour is already first
      }).map(function (a) {
        var label = a.id === 'product' ? product().name + ' colour (default)' : a.name;
        return '<button type="button" class="bb-accent' + (a.id === 'product' ? ' product' : '') + '" role="radio" data-bb-accent-id="' + a.id + '" aria-checked="' + (a.id === acc) + '" aria-label="' + esc(label) + '" data-tip="' + esc(label) + '" style="--sw:' + (a.color || own) + '">' + ICON.check + '</button>';
      }).join('') + '</div>';
  }

  var openMenus = [];
  function closeAll(except) {
    openMenus.slice().forEach(function (m) { if (m !== except) m.close(); });
  }
  /**
   * Wire a button to a popover menu: toggles aria-expanded, closes on outside click or Escape, and places the
   * menu under the button (right-aligned when the button sits in the right half of the screen).
   */
  function popover(button, menu, onOpen) {
    var api = {
      open: function () {
        closeAll(api);
        if (onOpen) onOpen(menu);
        menu.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        place();
        if (openMenus.indexOf(api) < 0) openMenus.push(api);
      },
      close: function () {
        menu.hidden = true;
        button.setAttribute('aria-expanded', 'false');
        var i = openMenus.indexOf(api);
        if (i >= 0) openMenus.splice(i, 1);
      },
      toggle: function () { if (menu.hidden) api.open(); else api.close(); }
    };
    function place() {
      var r = button.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.top = Math.round(r.bottom + 10) + 'px';
      var w = menu.offsetWidth;
      var right = r.left + r.width / 2 > global.innerWidth / 2;
      var x = right ? r.right - w : r.left;
      menu.style.left = Math.round(Math.max(12, Math.min(x, global.innerWidth - w - 12))) + 'px';
    }
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    menu.hidden = true;
    button.addEventListener('click', function (e) { e.stopPropagation(); api.toggle(); });
    menu.addEventListener('click', function (e) { e.stopPropagation(); });
    global.addEventListener('resize', function () { if (!menu.hidden) place(); });
    return api;
  }
  doc.addEventListener('click', function () { closeAll(null); });
  doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(null); });

  function mountSwitcher(button, menu, current) {
    menu.setAttribute('role', 'menu');
    return popover(button, menu, function (m) { if (!m.childElementCount) m.innerHTML = productMenu(current); });
  }
  function mountThemes(button, menu) {
    var api = popover(button, menu, function (m) { m.innerHTML = themeMenu(); });
    menu.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-bb-theme-id]') : null;
      var a = e.target.closest ? e.target.closest('[data-bb-accent-id]') : null;
      if (t) setTheme(t.getAttribute('data-bb-theme-id'));
      else if (a) setAccent(a.getAttribute('data-bb-accent-id'));
      else return;
      menu.innerHTML = themeMenu();
    });
    return api;
  }
  /** Secondary tools (.bb-t2 inside toolsRoot) are mirrored as tiles in the More menu on narrow screens. */
  function mountMore(button, menu, toolsRoot) {
    return popover(button, menu, function (m) {
      m.innerHTML = '';
      toolsRoot.querySelectorAll('.bb-t2').forEach(function (src) {
        if (src.classList.contains('bb-sep')) return;
        var item = doc.createElement('button');
        item.type = 'button';
        item.className = 'bb-menu-item';
        item.setAttribute('role', 'menuitem');
        item.innerHTML = src.innerHTML + '<span>' + esc(src.getAttribute('aria-label') || src.getAttribute('data-tip') || '') + '</span>';
        item.addEventListener('click', function () { src.click(); });
        m.appendChild(item);
      });
    });
  }

  // ---- range fill ---------------------------------------------------------------------------------------------

  /** Keep a .bb-range's accent fill in step with its value. */
  function rangeFill(el) {
    var min = parseFloat(el.min || '0'), max = parseFloat(el.max || '100'), v = parseFloat(el.value);
    var p = max > min ? ((v - min) / (max - min)) * 100 : 0;
    el.style.setProperty('--fill', Math.max(0, Math.min(100, p)).toFixed(2) + '%');
  }
  function syncRanges(root) {
    (root || doc).querySelectorAll('.bb-range').forEach(rangeFill);
  }
  doc.addEventListener('input', function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains('bb-range')) rangeFill(t);
  }, true);

  // ---- tooltips ---------------------------------------------------------------------------------------------

  var tipEl = null;
  function initTips() {
    if (tipEl || !global.matchMedia || !global.matchMedia('(hover: hover)').matches) return;
    tipEl = doc.createElement('div');
    tipEl.className = 'bb-tip';
    tipEl.setAttribute('role', 'tooltip');
    doc.body.appendChild(tipEl);
    var timer = 0, warmUntil = 0, cur = null;
    function show(el) {
      var text = el.getAttribute('data-tip');
      if (!text) return;
      tipEl.textContent = text;
      var r = el.getBoundingClientRect();
      var side = el.getAttribute('data-tip-side') || (r.top < 90 ? 'bottom' : 'top');
      tipEl.style.left = '0px'; tipEl.style.top = '0px';
      var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
      var x = side === 'right' ? r.right + 10 : r.left + r.width / 2 - w / 2;
      var y = side === 'right' ? r.top + r.height / 2 - h / 2 : side === 'bottom' ? r.bottom + 8 : r.top - h - 8;
      tipEl.style.left = Math.round(Math.max(8, Math.min(x, global.innerWidth - w - 8))) + 'px';
      tipEl.style.top = Math.round(Math.max(8, y)) + 'px';
      tipEl.setAttribute('data-on', '');
    }
    function hide() { clearTimeout(timer); if (tipEl.hasAttribute('data-on')) warmUntil = Date.now() + 400; tipEl.removeAttribute('data-on'); cur = null; }
    doc.addEventListener('pointerover', function (e) {
      var el = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (el === cur) return;
      hide();
      if (!el || e.pointerType === 'touch') return;
      cur = el;
      timer = setTimeout(function () { show(el); }, Date.now() < warmUntil ? 0 : 320);
    });
    doc.addEventListener('pointerdown', hide, true);
    global.addEventListener('scroll', hide, true);
  }

  // ---- coach-mark hints -------------------------------------------------------------------------------------

  var hints = {};
  /** Show a hint once per session next to anchor() (an element getter), unless it was dismissed. */
  function hint(id, anchor, text, opts) {
    opts = opts || {};
    if (store.sget('bb.hint.' + id) || hints[id]) return;
    setTimeout(function () {
      var target = anchor();
      if (!target || store.sget('bb.hint.' + id)) return;
      var el = doc.createElement('div');
      el.className = 'bb-hint';
      el.setAttribute('role', 'status');
      el.innerHTML = '<span></span><button type="button" aria-label="Dismiss">&times;</button>';
      el.firstChild.textContent = text;
      el.lastChild.addEventListener('click', function () { dismissHint(id); });
      doc.body.appendChild(el);
      hints[id] = el;
      var place = function () {
        var t = anchor();
        if (!t) return dismissHint(id, true);
        var r = t.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
        var below = opts.place === 'below' || (opts.place !== 'above' && r.top < global.innerHeight / 2);
        el.style.left = Math.round(Math.max(12, Math.min(r.left + r.width / 2 - w / 2, global.innerWidth - w - 12))) + 'px';
        el.style.top = Math.round(below ? r.bottom + 12 : r.top - h - 12) + 'px';
      };
      place();
      global.addEventListener('resize', place);
      el._place = place;
    }, opts.delay || 900);
  }
  function dismissHint(id, silent) {
    var el = hints[id];
    if (!silent) store.sset('bb.hint.' + id, '1');
    if (!el) return;
    global.removeEventListener('resize', el._place);
    el.remove();
    delete hints[id];
  }

  global.BlackboxesFamily = {
    PRODUCTS: PRODUCTS, THEMES: THEMES, ACCENTS: ACCENTS, DEFAULT_THEME: DEFAULT_THEME,
    getTheme: getTheme, setTheme: setTheme, applyTheme: applyTheme, watchTheme: watchTheme, setProduct: setProduct, product: product,
    getAccent: getAccent, setAccent: setAccent, applyAccent: applyAccent, accentColor: accentColor,
    mark: mark, productMenu: productMenu, themeMenu: themeMenu,
    popover: popover, mountSwitcher: mountSwitcher, mountThemes: mountThemes, mountMore: mountMore,
    initTips: initTips, hint: hint, dismissHint: dismissHint, icons: ICON, rangeFill: rangeFill, syncRanges: syncRanges
  };
  // Apply the stored theme as early as possible to avoid a flash of the default surface.
  if (doc && doc.documentElement) { applyTheme(); applyAccent(); }
})(typeof window !== 'undefined' ? window : globalThis);
