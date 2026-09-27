import { html, setMarkup } from '../ui/markup'
/*
 * Blackboxes family: shared behaviour for ecosystem.blackboxes.net, the nine engines and ob.Pal.
 * A dependency-free classic script (works inlined or imported). Exposes window.BlackboxesFamily.
 *
 *   theme    surface choice, remembered across every *.blackboxes.net site (a parent-domain cookie)
 *   product  identity accent; never changed by the theme
 *   mark     the obsidian cube lit in the product's colour (ob.Pal keeps its orbit)
 *   menus    product switcher, theme picker and the "More" overflow for secondary tools
 *   ranges   each .bb-range slider's accent fill, kept in step with its value
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
    var title = opts.title === false ? '' : html`<title>${p.name}</title>`;
    var ring = orbit
      ? html`<ellipse cx="50" cy="57" rx="47" ry="15" transform="rotate(-14 50 57)" fill="none" stroke="${a}" stroke-width="3" opacity=".32"/>`
      : '';
    var front = orbit
      ? html`<path d="M95.6 45.63 A47 15 -14 0 1 4.4 68.37" fill="none" stroke="${a}" stroke-width="3.8" stroke-linecap="round"/><circle cx="82.1" cy="60.8" r="4.8" fill="${a}"/><circle cx="82.1" cy="60.8" r="1.8" fill="#fff"/>`
      : '';
    // Engines fill the frame: the cube is scaled up a little when there's no ring around it.
    return html`<svg class="bb-mark" viewBox="0 0 100 100" role="img" aria-label="${p.name}" shape-rendering="geometricPrecision">${title}<defs><linearGradient id="${id}t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#565656"/><stop offset=".35" stop-color="#2a2a2a"/><stop offset=".75" stop-color="#141414"/><stop offset="1" stop-color="#050505"/></linearGradient><linearGradient id="${id}l" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d1d1d"/><stop offset=".45" stop-color="#0a0a0a"/><stop offset="1" stop-color="#000"/></linearGradient><linearGradient id="${id}r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#313131"/><stop offset=".5" stop-color="#141414"/><stop offset="1" stop-color="#050505"/></linearGradient><linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset=".42" stop-color="${a}" stop-opacity="0"/><stop offset="1" stop-color="${a}" stop-opacity=".5"/></linearGradient></defs>${ring}<g transform="${orbit ? '' : 'translate(50 50) scale(1.16) translate(-50 -49.8)'}"><polygon points="50,19 78,34.4 78,65.2 50,80.6 22,65.2 22,34.4" fill="#000"/><polygon points="50,19 78,34.4 50,49.8 22,34.4" fill="url(#${id}t)"/><polygon points="22,34.4 50,49.8 50,80.6 22,65.2" fill="url(#${id}l)"/><polygon points="50,49.8 78,34.4 78,65.2 50,80.6" fill="url(#${id}r)"/><polygon points="22,34.4 50,49.8 50,80.6 22,65.2" fill="url(#${id}s)" opacity=".7"/><polygon points="50,49.8 78,34.4 78,65.2 50,80.6" fill="url(#${id}s)"/><polygon points="50,19 78,34.4 78,65.2 50,80.6 22,65.2 22,34.4" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="1.3" stroke-linejoin="round"/><path d="M50,49.8 L50,80.6" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="1.3"/><path d="M22,34.4 L50,49.8 L78,34.4" fill="none" stroke="${a}" stroke-width="2.4" stroke-linejoin="round"/><line x1="50" y1="19" x2="78" y2="34.4" stroke="rgba(255,255,255,.72)" stroke-width="1.3"/><line x1="50" y1="19" x2="78" y2="34.4" stroke="${a}" stroke-width="1.4" opacity=".55"/></g>${front}</svg>`;
  }

  // ---- menus ------------------------------------------------------------------------------------------------

  var ICON = {
    chevron: '<svg class="bb-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    check: '<svg class="bb-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>'
  };
  var rgbOf = function (hex) { var n = parseInt(hex.slice(1), 16); return ((n >> 16) & 255) + ' ' + ((n >> 8) & 255) + ' ' + (n & 255); };

  /**
   * Menu items linking to every product's home, current one marked. A site can give its own link for a product
   * (`opts.href(product)`: a local preview, a .dev alias) and a class for each item (`opts.itemClass`).
   */
  function productMenu(current, opts) {
    opts = opts || {};
    var href = function (p) { var h = typeof opts.href === 'function' ? opts.href(p) : ''; return h || 'https://' + p.host + '/'; };
    var cls = 'bb-menu-item' + (opts.itemClass ? ' ' + opts.itemClass : '');
    return PRODUCTS.map(function (p, i) {
      var sep = i === 1 ? html`<div class="bb-label bb-menu-group">Engines</div>` : i === PRODUCTS.length - 1 ? html`<div class="bb-label bb-menu-group">Tools</div>` : '';
      return html`${sep}<a class="${cls}" role="menuitem" href="${href(p)}" style="--bb-item-rgb:${rgbOf(p.accent)}" aria-current="${p.id === current ? 'page' : 'false'}">${mark(p.id, { title: false })}<span><b style="color:${p.accent}">${p.name}</b><small>${p.category}</small></span></a>`;
    });
  }
  function themeMenu() {
    var cur = getTheme(), acc = getAccent(), own = product().accent;
    return html`<div class="bb-label bb-menu-group">Surface</div><div class="bb-themes" role="radiogroup" aria-label="Surface">${THEMES.map(function (t) {
        return html`<button type="button" class="bb-theme" role="radio" data-bb-theme-id="${t.id}" aria-checked="${(t.id === cur)}"><i style="background:linear-gradient(135deg,${t.surface},${t.page})"></i>${t.name}</button>`;
      })}</div><div class="bb-label bb-menu-group">Accent</div><div class="bb-accents" role="radiogroup" aria-label="Accent">${ACCENTS.filter(function (a) {
        return !a.color || a.color.toLowerCase() !== own.toLowerCase() || a.id === acc; // the product colour is already first
      }).map(function (a) {
        var label = a.id === 'product' ? product().name + ' colour (default)' : a.name;
        return html`<button type="button" class="bb-accent${(a.id === 'product' ? ' product' : '')}" role="radio" data-bb-accent-id="${a.id}" aria-checked="${(a.id === acc)}" aria-label="${label}" data-tip="${label}" style="--sw:${(a.color || own)}">${ICON.check}</button>`;
      })}</div>`;
  }

  var openMenus = [];
  var menuSeq = 0;
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
      var top = Math.round(r.bottom + 10);
      menu.style.position = 'fixed';
      menu.style.top = top + 'px';
      // A short screen scrolls the menu, so its last item is always reachable.
      menu.style.maxHeight = Math.max(160, global.innerHeight - top - 12) + 'px';
      menu.style.overflowY = 'auto';
      var w = menu.offsetWidth;
      var right = r.left + r.width / 2 > global.innerWidth / 2;
      var x = right ? r.right - w : r.left;
      menu.style.left = Math.round(Math.max(12, Math.min(x, global.innerWidth - w - 12))) + 'px';
    }
    // Keyboard: arrows open it and move through its items, Home and End jump, Escape closes it back to the button.
    function items() { return Array.prototype.slice.call(menu.querySelectorAll('a[href],button:not([disabled])')); }
    function focusItem(i) { var list = items(); if (list.length) list[(i + list.length) % list.length].focus(); }
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    // The button names the menu it opens, for assistive tech.
    if (!menu.id) menu.id = 'bb-menu-' + (++menuSeq);
    button.setAttribute('aria-controls', menu.id);
    menu.hidden = true;
    button.addEventListener('click', function (e) { e.stopPropagation(); api.toggle(); });
    button.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      if (menu.hidden) api.open();
      focusItem(e.key === 'ArrowDown' ? 0 : -1);
    });
    menu.addEventListener('keydown', function (e) {
      var list = items(), i = list.indexOf(doc.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(i + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(i - 1); }
      else if (e.key === 'Home') { e.preventDefault(); focusItem(0); }
      else if (e.key === 'End') { e.preventDefault(); focusItem(-1); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api.close(); button.focus(); }
    });
    menu.addEventListener('click', function (e) { e.stopPropagation(); });
    global.addEventListener('resize', function () { if (!menu.hidden) place(); });
    return api;
  }
  doc.addEventListener('click', function () { closeAll(null); });
  doc.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !openMenus.length) return;
    // Escape from the button that opened a menu keeps focus there.
    var owner = doc.activeElement;
    closeAll(null);
    if (owner && owner.focus) owner.focus();
  });

  function mountSwitcher(button, menu, current, opts) {
    menu.setAttribute('role', 'menu');
    return popover(button, menu, function (m) { if (!m.childElementCount) setMarkup(m, productMenu(current, opts)); });
  }
  function mountThemes(button, menu) {
    var api = popover(button, menu, function (m) { setMarkup(m, themeMenu()); });
    menu.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-bb-theme-id]') : null;
      var a = e.target.closest ? e.target.closest('[data-bb-accent-id]') : null;
      if (t) setTheme(t.getAttribute('data-bb-theme-id'));
      else if (a) setAccent(a.getAttribute('data-bb-accent-id'));
      else return;
      setMarkup(menu, themeMenu());
    });
    return api;
  }
  /** Secondary tools (.bb-t2 inside toolsRoot) are mirrored as tiles in the More menu on narrow screens. */
  function mountMore(button, menu, toolsRoot) {
    return popover(button, menu, function (m) {
      m.replaceChildren();
      toolsRoot.querySelectorAll('.bb-t2').forEach(function (src) {
        if (src.classList.contains('bb-sep')) return;
        var item = doc.createElement('button');
        item.type = 'button';
        item.className = 'bb-menu-item';
        item.setAttribute('role', 'menuitem');
        setMarkup(item, html`${[...src.childNodes].map((n) => n.cloneNode(true))}<span>${src.getAttribute('aria-label') || src.getAttribute('data-tip') || ''}</span>`);
        item.addEventListener('click', function () { src.click(); });
        m.appendChild(item);
      });
    });
  }

  // ---- range fill ---------------------------------------------------------------------------------------------
  // A .bb-range's track is filled with the accent up to its knob (--fill), kept in step with its value however it
  // changes: a person dragging it, code setting value, valueAsNumber or stepUp/stepDown, new min/max/step/value
  // attributes, a form reset, or the slider arriving in the page with its value already set.

  /** The filled share (0 to 1) of a slider at `value` between `min` and `max`: clamped, and empty for an empty range. */
  function rangeShare(value, min, max) {
    if (!(max > min) || value !== value) return 0;
    return value <= min ? 0 : value >= max ? 1 : (value - min) / (max - min);
  }
  /** A range input's bound: its attribute as a number, else the HTML default (min 0, max 100). */
  function bound(attr, fallback) {
    var n = parseFloat(attr);
    return isFinite(n) ? n : fallback;
  }
  /** Keep a .bb-range's accent fill in step with its value. */
  function rangeFill(el) {
    el.style.setProperty('--fill', (rangeShare(parseFloat(el.value), bound(el.min, 0), bound(el.max, 100)) * 100).toFixed(2) + '%');
    watchRange(el);
  }
  function syncRanges(root) {
    (root || doc).querySelectorAll('.bb-range').forEach(rangeFill);
  }

  // Values set in code: the slider gets its own value and valueAsNumber (wrapping the input's) and step methods.
  var inputProto = global.HTMLInputElement && global.HTMLInputElement.prototype;
  var valueDesc = inputProto && Object.getOwnPropertyDescriptor(inputProto, 'value');
  var numberDesc = inputProto && Object.getOwnPropertyDescriptor(inputProto, 'valueAsNumber');
  function watchRange(el) {
    if (el._bbRange || !valueDesc || el.type !== 'range') return;
    el._bbRange = true;
    var refill = function (desc) {
      return { configurable: true, enumerable: true, get: desc.get, set: function (v) { desc.set.call(this, v); rangeFill(this); } };
    };
    Object.defineProperty(el, 'value', refill(valueDesc));
    if (numberDesc) Object.defineProperty(el, 'valueAsNumber', refill(numberDesc));
    ['stepUp', 'stepDown'].forEach(function (m) {
      var step = inputProto[m];
      if (step) el[m] = function () { step.apply(this, arguments); rangeFill(this); };
    });
    if (el.classList.contains('vertical')) checkVertical();
  }

  /** Browsers whose form controls can't stand up (before Chrome 124, Safari 17.4, Firefox 120) turn vertical sliders. */
  var vertical = null;
  function checkVertical() {
    var root = doc.documentElement;
    if (vertical !== null || !root) return;
    var probe = doc.createElement('input');
    probe.type = 'range';
    probe.style.cssText = 'position:absolute;visibility:hidden;writing-mode:vertical-lr';
    root.appendChild(probe);
    vertical = probe.offsetHeight > probe.offsetWidth;
    root.removeChild(probe);
    if (!vertical) root.setAttribute('data-bb-vranges', 'rotate');
  }

  doc.addEventListener('input', function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains('bb-range')) rangeFill(t);
  }, true);
  // A reset puts a form's values back without an input event; refill once it has.
  doc.addEventListener('reset', function (e) {
    var form = e.target;
    setTimeout(function () { if (form.querySelectorAll) syncRanges(form); }, 0);
  }, true);
  // Sliders fill as they arrive (their value may already be set), and refill when their attributes change.
  if (global.MutationObserver && doc.documentElement) {
    new global.MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'attributes') {
          if (r.target.classList.contains('bb-range')) rangeFill(r.target);
          continue;
        }
        for (var j = 0; j < r.addedNodes.length; j++) {
          var n = r.addedNodes[j];
          if (n.nodeType !== 1) continue;
          if (n.classList.contains('bb-range')) rangeFill(n);
          else if (n.firstElementChild) syncRanges(n);
        }
      }
    }).observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['min', 'max', 'step', 'value'] });
    syncRanges(doc);
  }

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
      setMarkup(el, html`<span></span><button type="button" aria-label="Dismiss">&times;</button>`);
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
    initTips: initTips, hint: hint, dismissHint: dismissHint, icons: ICON, rangeShare: rangeShare, rangeFill: rangeFill, syncRanges: syncRanges
  };
  // Apply the stored theme as early as possible to avoid a flash of the default surface.
  if (doc && doc.documentElement) { applyTheme(); applyAccent(); }
})(typeof window !== 'undefined' ? window : globalThis);
