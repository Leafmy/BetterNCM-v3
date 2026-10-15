/* loader.js -- injects the Material 3 stylesheets in a defined order.
 *
 * The theme is authored as real, reviewable CSS files (theme/tokens/*, theme/components/*,
 * theme/compatibility/*) instead of an opaque string inside a minified bundle.  This file fetches
 * them from the plugin package over the loader's own endpoint and injects one <style> per file,
 * with a data attribute so the set is identifiable and idempotent.
 *
 * Order matters and is explicit:
 *   tokens  -> components -> compatibility -> index
 * so component rules can rely on tokens, and compatibility overrides can win over both.
 */
(function () {
  'use strict';
  var BUILD = 'bncm-m3-theme-loader/0.1.0';
  var SLUG = 'MaterialYouTheme';

  // Files in load order.  Keep this list in sync with the directory contents; a missing file is
  // reported, not silently skipped.  Component files are added as their phase lands.
  var STYLES = [
    'tokens/color.css',
    'tokens/radius.css',
    'tokens/elevation.css',
    'tokens/typography.css',
    'tokens/motion.css',
    'components/surfaces.css',
    'components/sidebar.css',
    'components/navigation.css',
    'components/buttons.css',
    'components/inputs.css',
    'components/slider.css',
    'components/tabs.css',
    'components/menus.css',
    'components/dialogs.css',
    'components/player.css',
    'components/playlist.css',
    'components/motion.css',
    'compatibility/plugins.css',
    'index.css',
  ];

  if (window.__BNCM_M3_THEME__ && window.__BNCM_M3_THEME__.build === BUILD) return;

  var cfg = window.__BNCM_CONFIG__ || {};
  var API = cfg.api || null;
  var KEY = cfg.key || '';
  /* The files live under theme/ inside the package, and the host serves them by EXACT path.
   *
   * This was a real bug: the list above used bare names ("tokens/motion.css"), which the host
   * resolves through a basename fallback -- fine until two files share a basename.
   * tokens/motion.css and components/motion.css do, so both requests 500'd and the phase-6 motion
   * tokens were silently absent.  Always request the real path. */
  var BASE = 'theme/';
  var state = { build: BUILD, injected: [], missing: [], failed: [], markClass: false, base: BASE };

  function mark() {
    // Scope class.  Everything in the theme is written under html.m3-theme, so the client and other
    // plugins are never restyled by accident.
    try {
      document.documentElement.classList.add('m3-theme');
      state.markClass = true;
    } catch (e) { state.failed.push('mark: ' + e.message); }
  }

  function injectAsset(path, text) {
    var el = document.getElementById('bncm-m3-css-' + path.replace(/[^a-z0-9]+/gi, '-'));
    if (!el) {
      el = document.createElement('style');
      el.id = 'bncm-m3-css-' + path.replace(/[^a-z0-9]+/gi, '-');
      el.setAttribute('data-bncm-m3', path);
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = text;
    state.injected.push(path);
  }

  function fetchAsset(path) {
    if (!API) return Promise.reject(new Error('no backend api in config'));
    return fetch(API + '/api/plugin/' + SLUG + '/' + BASE + path, { headers: { 'X-BNCM-Key': KEY } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
  }

  /** Load one file.
   *
   *  A failure here is recorded rather than swallowed: the phase-6 bug above was invisible for a
   *  while precisely because a missing stylesheet only showed up as one absent entry in a list
   *  nobody read.  Failures are also logged loudly at the end. */
  function loadOne(path) {
    return fetchAsset(path).then(function (text) {
      injectAsset(path, text);
    }, function (e) {
      var msg = String(e && e.message);
      if (/404/.test(msg)) state.missing.push(path);
      else state.failed.push(path + ': ' + msg);
    });
  }

  mark();
  // Sequential on purpose: the cascade order must match the array above.
  var chain = Promise.resolve();
  STYLES.forEach(function (p) { chain = chain.then(function () { return loadOne(p); }); });

  window.__BNCM_M3_THEME__ = state;
  chain.then(function () {
    if (state.failed.length) {
      console.warn('[m3-theme] ' + state.failed.length + ' stylesheet(s) failed:', state.failed);
    }
    console.log('[m3-theme] injected ' + state.injected.length + ' stylesheet(s)' +
      (state.missing.length ? ', ' + state.missing.length + ' not present yet' : ''));
  });
})();
