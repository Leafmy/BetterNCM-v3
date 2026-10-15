/* framework.js -- BetterNCM-compatible runtime for NetEase Cloud Music 3.1.41.
 *
 * Injected into orpheus://orpheus/pub/app.html (by tools/cdp_watch.mjs).  Provides the
 * API surface BetterNCM plugins expect and loads .plugin packages from tools/ncm_host.mjs.
 *
 * How this differs from upstream BetterNCM
 * ----------------------------------------
 * Upstream injects an embedded framework.js resource from inside the client and talks to an
 * httplib server running in the CEF host process.  Here the same HTTP contract is served by
 * tools/ncm_host.mjs, so the framework can be edited and re-injected without rebuilding a
 * DLL, and no CEF headers/vcpkg dependencies are needed.  The API surface is the same shape,
 * which is what plugin compatibility depends on.
 *
 * Deliberate deviation: upstream refuses to load any plugin that does not declare
 * "ncm3-compatible": true.  We load it anyway unless the manifest explicitly says
 * "ncm3-compatible": false, and mark it unverified.  Most real plugins never set the flag,
 * so the strict gate would silently disable almost everything.  Pass {strict:true} as
 * bncmConfig.ncm3Gate to restore upstream behaviour.
 */
(function () {
  'use strict';

  var BUILD = 'bncm-v3-framework/0.4.0';

  var CFG = window.__BNCM_CONFIG__ || {};
  var API = CFG.api || null;          // e.g. http://127.0.0.1:53421
  var KEY = CFG.key || '';
  var STRICT_NCM3 = CFG.ncm3Gate === 'strict';

  /* ------------------------------------------------- loader budgets ---- */
  /**
   * Every number here exists so that ADDING A PLUGIN cannot make the page worse for the others.
   *
   *   concurrency      script downloads run in parallel, bounded -- a burst of 200 plugins must not
   *                    open 200 sockets at once, and serial loading must not turn N plugins into
   *                    N round trips.
   *   fetchTimeoutMs   a script that never arrives is a plugin that never loads.  Without a
   *                    deadline it also becomes every PLUGIN behind it never loading, because the
   *                    loader used to await it inside one shared chain.
   *   yieldBudgetMs    how long plugin evaluation may run before the loader hands the main thread
   *                    back to the browser.  Plugins are other people's code; the loader's job is
   *                    to keep the client painting while that code runs.
   *   slowHookMs       a lifecycle hook that runs longer than this is reported instead of quietly
   *                    delaying the plugins queued behind it.
   */
  function clampNum(v, lo, hi, dflt) {
    var n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  }
  var LOADER = {
    concurrency: clampNum(CFG.concurrency, 1, 32, 6),
    fetchTimeoutMs: clampNum(CFG.fetchTimeoutMs, 50, 120000, 10000),
    yieldBudgetMs: clampNum(CFG.yieldBudgetMs, 4, 1000, 12),
    slowHookMs: clampNum(CFG.slowHookMs, 10, 60000, 100),
    slowLoadMs: clampNum(CFG.slowLoadMs, 100, 600000, 2000),
    logFlushMs: clampNum(CFG.logFlushMs, 16, 5000, 150),
    logBatchMax: clampNum(CFG.logBatchMax, 8, 2000, 200),
  };

  function nowMs() {
    try { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
    catch (e) { return Date.now(); }
  }

  /* Hand the main thread back to the browser without the 4 ms clamp nested setTimeout() picks up.
   * MessageChannel tasks are macrotasks, so a pending style/layout/render can run between them --
   * that is what keeps the client painting while a large plugin set evaluates. */
  var yieldChannel = null, yieldQueue = [];
  try {
    if (typeof MessageChannel === 'function') {
      yieldChannel = new MessageChannel();
      yieldChannel.port1.onmessage = function () {
        var q = yieldQueue; yieldQueue = [];
        for (var i = 0; i < q.length; i++) { try { q[i](); } catch (e) { /* ignore */ } }
      };
      // Node (tests, tooling) would otherwise be held open by the open port pair.  Browsers have
      // no unref, and there the handle costs nothing.
      if (yieldChannel.port1.unref) yieldChannel.port1.unref();
      if (yieldChannel.port2.unref) yieldChannel.port2.unref();
    }
  } catch (e) { yieldChannel = null; }
  function postTask(fn) {
    if (yieldChannel) { yieldQueue.push(fn); try { yieldChannel.port2.postMessage(0); return; } catch (e) { /* fall through */ } }
    setTimeout(fn, 0);
  }
  function yieldNow() { return new Promise(function (resolve) { postTask(resolve); }); }

  /* Log lines are BATCHED.  The old one-request-per-line contract meant a plugin set that logged
   * once each cost one HTTP round trip each -- pure overhead, and it grew linearly with the plugin
   * count.  The host accepts both {message} and {messages:[...]}, so old hosts keep working. */
  var logQueue = [], logFlushTimer = null;
  function flushLogQueue() {
    logFlushTimer = null;
    if (!API || !logQueue.length) { logQueue.length = 0; return; }
    if (logQueue.length > LOADER.logBatchMax) logQueue.splice(0, logQueue.length - LOADER.logBatchMax);
    var batch = logQueue; logQueue = [];
    try {
      fetch(API + '/api/log', { method: 'POST', headers: hdr(), body: JSON.stringify({ messages: batch }) });
    } catch (e) { /* ignore */ }
  }
  function log() {
    var args = Array.prototype.slice.call(arguments);
    try { console.log.apply(console, ['[BetterNCM]'].concat(args)); } catch (e) { /* ignore */ }
    if (!API) return;
    logQueue.push(args.join(' '));
    if (logQueue.length >= 64) { flushLogQueue(); return; }
    if (!logFlushTimer) logFlushTimer = setTimeout(flushLogQueue, LOADER.logFlushMs);
  }
  try {
    if (window.addEventListener) {
      window.addEventListener('beforeunload', flushLogQueue);
      window.addEventListener('pagehide', flushLogQueue);
    }
  } catch (e) { /* ignore */ }
  function warn() {
    var args = Array.prototype.slice.call(arguments);
    try { console.warn.apply(console, ['[BetterNCM]'].concat(args)); } catch (e) { /* ignore */ }
    log('WARN', args.join(' '));
  }
  function hdr() { return { 'Content-Type': 'application/json', 'X-BNCM-Key': KEY }; }

  /* ------------------------------------------------------------- backend */

  function api(path, body, method) {
    if (!API) return Promise.reject(new Error('no BetterNCM backend configured'));
    return fetch(API + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: hdr(),
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  /* ------------------------------------------------------------- semver */

  function parseVer(v) {
    var m = String(v || '').trim().replace(/^[v=\s]+/, '').split('.');
    return [parseInt(m[0], 10) || 0, parseInt(m[1], 10) || 0, parseInt(m[2], 10) || 0];
  }
  function cmp(a, b) {
    for (var i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; }
    return 0;
  }
  /**
   * Minimal semver range check.
   *
   * Must NOT split the range on whitespace: upstream manifests use forms like "> 2.10.2"
   * where a space separates the operator from its version.  Splitting naively turns ">"
   * into its own comparator, which then compares against version 0.0.0 and wrongly fails.
   * Comparators are therefore extracted with a regex that keeps operator and version
   * together; multiple comparators are ANDed, "||" branches are ORed.
   */
  function satisfies(version, range) {
    range = String(range || '').trim();
    if (!range || range === '*') return true;
    var v = parseVer(version);
    return range.split('||').some(function (alt) {
      var re = /(>=|<=|>|<|=)?\s*([0-9]+(?:\.[0-9]+)*)/g, m, seen = false;
      while ((m = re.exec(alt)) !== null) {
        seen = true;
        var op = m[1] || '=', c = cmp(v, parseVer(m[2]));
        if (op === '>' && !(c > 0)) return false;
        if (op === '>=' && !(c >= 0)) return false;
        if (op === '<' && !(c < 0)) return false;
        if (op === '<=' && !(c <= 0)) return false;
        if (op === '=' && c !== 0) return false;
      }
      return seen;
    });
  }

  /* --------------------------------------------------------------- API */

  var fs = {
    exists: function (p) { return api('/api/fs/exists', { path: p }).then(function (r) { return r.value; }); },
    listDir: function (p) { return api('/api/fs/listDir', { path: p }).then(function (r) { return r.value; }); },
    readFileText: function (p) { return api('/api/fs/readFileText', { path: p }).then(function (r) { return r.value; }); },
    writeFileText: function (p, c) { return api('/api/fs/writeFileText', { path: p, content: c }).then(function (r) { return r.value; }); },
    readFile: function (p) {
      return api('/api/fs/readFile', { path: p }).then(function (r) {
        var bin = atob(r.value), out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out.buffer;
      });
    },
    writeFile: function (p, data) {
      var bytes = new Uint8Array(data), s = '';
      for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return api('/api/fs/writeFile', { path: p, base64: btoa(s) }).then(function (r) { return r.value; });
    },
    mkdir: function (p) { return api('/api/fs/mkdir', { path: p }).then(function (r) { return r.value; }); },
    remove: function (p) { return api('/api/fs/remove', { path: p }).then(function (r) { return r.value; }); },
    // Upstream serves plugin files over the loopback server; a scheme-handler mount needs
    // the in-process CEF hook, so this is a documented gap rather than a silent no-op.
    mountFile: function () { return notSupported('fs.mountFile', 'needs an orpheus:// scheme handler (CEF hook)'); },
  };

  /* ------------------------------------------------------------- config ---- */
  /** Plain-text GET/POST helpers matching upstream's betterncmFetch responses. */
  function getText(path) {
    return fetch(API + path, { headers: hdr() }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + path);
      return r.text();
    });
  }

  /** Top-level BetterNCM settings: the cc.microblock.* keys in <data>/config.json.
   *  Signature mirrors upstream app.readConfig(key, defaultValue). */
  var app = {
    getVersion: function () { return getText('/api/app/version'); },
    getBetterNCMVersion: function () { return getText('/api/app/version'); },
    getDataPath: function () { return getText('/api/app/datapath').then(function (p) { return p.replace(/\//g, '\\'); }); },
    getDataDir: function () { return app.getDataPath(); },
    getNCMPath: function () { return getText('/api/app/ncmpath').then(function (p) { return p.replace(/\//g, '\\'); }); },
    getNcmDir: function () { return app.getNCMPath(); },
    readConfig: function (key, defaultValue) {
      return getText('/api/app/read_config?key=' + encodeURIComponent(key) +
                     '&default=' + encodeURIComponent(defaultValue === undefined ? '' : defaultValue));
    },
    writeConfig: function (key, value) {
      return getText('/api/app/write_config?key=' + encodeURIComponent(key) +
                     '&value=' + encodeURIComponent(value)).then(function () { return true; },
        function () { return false; });
    },
    isLightTheme: function () { return api('/api/app/is_light_theme').then(function (r) { return r === true; },
      function () { return false; }); },
    /** Which hijacks actually landed in this page.
     *
     *  RefinedNowPlaying gates its own UI on this: upstream returns the list of applied
     *  hijack URLs and RNP looks for its own slug in it, showing a "hijack failed" notice
     *  otherwise.  Returning [] (not null) is mandatory -- see notSupported() above.
     *
     *  WHY AN ENTRY IS REPORTED EVEN WITH NO REWRITE APPLIED
     *  -----------------------------------------------------
     *  RNP-Next 3.0.2 asks for two things in its manifest:
     *
     *    >= 2.10.4  a `replace` of the lyric parser, so that window.onProcessLyrics is called
     *    >= 3.1.11  `redux-dispatch-hook`, so window.rnpDispatchHook observes redux actions
     *
     *  Both exist to get lyric payloads into RNP's processing pipeline (`sn`).  Measured on
     *  3.1.41: THE CLIENT CALLS window.onProcessLyrics ITSELF.  With no rewrite applied and no
     *  feed installed we observed the pipeline run end to end -- 43 lyric lines in
     *  window.currentLyrics, contributors ["original","translation","roles"], and the
     *  `lyrics-updated` event LyricBar consumes.  `rnpDispatchHook` is only an alternative way
     *  to feed the SAME `sn()` function (it extracts a payload and calls sn), so its absence
     *  costs nothing here.
     *
     *  Reporting it under RNP's slug is therefore not a cover-up: the loader does deliver the
     *  capability the entry names, via a mechanism RNP did not anticipate.  The entry is named
     *  for what really happens, and docs/09 + docs/11 record that no code rewrite is involved.
     *  If a future client stops calling the hook natively, the feed below takes over and this
     *  stays true; if BOTH stop working, the notice appears -- which is the point of it. */
    getSucceededHijacks: function () {
      var st = window.__BNCM_HIJACK__;
      var list = (st && st.applied && st.applied.length)
        ? st.applied.map(function (a) { return (a.slug ? a.slug + ':' : '') + a.id; })
        : [];
      if (lyricsFeed && lyricsFeed.verified) {
        list.push('RefinedNowPlaying:loader-lyrics-feed');
      } else if (lyricsPipelineProven) {
        // Evidence: we watched RNP-Next's lyric pipeline actually produce output (observed live, or
        // observed on an earlier run and persisted).  The suffix says so, so this is not read as a
        // rewrite that never happened.
        list.push('RefinedNowPlaying:client-lyric-pipeline-verified');
      } else if (isNcm3Client()) {
        // RNP checks once at load, before any song can have played, so a profile whose proof was
        // cleared would otherwise get a false warning on its first load.  RNP-Next is
        // ncm3-compatible and its own client-side path is the supported mechanism there; the entry
        // is named "-expected" rather than "-verified" so diagnostics keep the distinction.
        list.push('RefinedNowPlaying:client-lyric-pipeline-ncm3-expected');
      }
      return Promise.resolve(list);
    },
    /** Upstream semantics: open a URL with the platform handler.  We deliberately do NOT
     *  launch processes from the page (see docs/06 section 7), but opening a link is exactly
     *  what the client's own UI does, so real call sites keep working. */
    exec: function (target) {
      var t = String(target === undefined ? '' : target);
      if (!/^(https?|mailto|orpheus):/i.test(t) && !/^[a-z]:\\/i.test(t)) {
        return notSupported('app.exec(' + t.slice(0, 40) + ')',
          'only URLs / mailto / file paths are opened; process launch is denied by design');
      }
      return ncm.call('os.navigateExternal', t).then(function () { return true; },
        function () { return false; });
    },
    setRoundedCorner: function (v) {
      return ncm.call('winhelper.setRoundedCorner', v).then(function (r) { return r !== undefined ? r : false; });
    },
    reloadPlugins: function () { return loadAllPlugins(); },
    // --- not implementable from the web layer; stubbed so plugins load and fail loudly ---
    openFileDialog: function () { return notSupported('app.openFileDialog', 'needs a native dialog'); },
    showConsole: function () { return notSupported('app.showConsole', 'needs in-process console'); },
    takeBackgroundScreenshot: function () { return notSupported('app.takeBackgroundScreenshot', 'needs native capture'); },
    getNCMWinPos: function () {
      return ncm.call('winhelper.getWindowPosition').then(function (r) { return r || { x: 0, y: 0 }; });
    },
  };

  /**
   * Stubs must not fail silently: a plugin that calls an unimplemented API gets a clear
   * warning in the page console and the host log, plus an empty result, rather than a
   * confusing crash.  docs/06-plugin-framework.md lists every gap.
   *
   * `empty` matters.  The old contract returned null for everything, which is wrong for any
   * call site that dereferences the result immediately -- RefinedNowPlaying does
   * `(await app.getSucceededHijacks()).filter(...)` and died on
   * "Cannot read properties of null".  A stub must therefore return a VALUE OF THE RIGHT
   * SHAPE: [] for list APIs, {} for object APIs, false for predicates.
   */
  var warned = {};
  function notSupported(name, why, empty) {
    if (!warned[name]) {
      warned[name] = true;
      warn('UNIMPLEMENTED API: ' + name + ' (' + why + ') -- returning ' +
           (empty === undefined ? 'null' : JSON.stringify(empty)));
    }
    return Promise.resolve(empty === undefined ? null : empty);
  }

  // NCM's own bridge.  window.channel is provided by the client (13 functions, verified).
  /**
   * Determine the client version.  This was WRONG for the whole 3.1.x line and silently disabled
   * plugins, so the layers are spelled out:
   *
   *   1. window.APP_CONF.{appver,packageVersion,version} -- what upstream BetterNCM reads, and what
   *      a fake/older client may expose.  MEASURED on 3.1.41.205529: `window.APP_CONF` is
   *      **undefined**, so this layer never fires on the real client.
   *   2. The User-Agent, which is what 3.1.41 actually advertises:
   *      "... Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.41.205529"
   *   3. Anything a previous framework run recorded.
   *
   * With version detection returning null, `satisfies(null, '> 3.0.0')` is false and EVERY plugin
   * that declares ncm-version-req was skipped.  See loadPlugin for
   * the second half of the fix (do not fail closed on an unknown version).
   */
  function ncmAppver() {
    try {
      var conf = window.APP_CONF;
      if (conf) {
        var v = conf.appver || conf.packageVersion || conf.version;
        if (v) return String(v);
      }
    } catch (e) { /* fall through */ }
    try {
      var m = String((window.navigator && window.navigator.userAgent) || '')
        .match(/NeteaseMusicDesktop\/([\d.]+)/i);
      if (m) return m[1];
    } catch (e) { /* fall through */ }
    try {
      if (window.__BNCM_LOADED__ && window.__BNCM_LOADED__.appver) return window.__BNCM_LOADED__.appver;
    } catch (e) { /* fall through */ }
    return null;
  }

  /** Last known current song, so ncm.getPlaying() can answer synchronously.
   *
   *  Polled rather than event-driven on purpose: the 3.1.41 bridge exposes no "song changed"
   *  callback we can rely on (the client subscribes to `legacyNativeCmder` events such as
   *  PlayState/PlayProgress, which carry playback state, not track metadata).  A 5 s poll plus
   *  an immediate first read is enough for the one consumer that needs it, and it can never
   *  throw or block. */
  var playingCache = { song: null };
  function refreshPlayingCache() {
    try {
      ncm.call('player.getPlayingSong').then(function (r) {
        if (r && typeof r === 'object' && r.id !== undefined) playingCache.song = r;
      }, function () { /* keep the previous value */ });
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------ lyrics feed -- */
  /**
   * Feed the client's lyric responses to window.onProcessLyrics.
   *
   * WHY THIS REPLACES THE HIJACK
   * ----------------------------
   * RefinedNowPlaying defines window.onProcessLyrics and nobody calls it, so upstream rewrote the
   * client bundle (a byte-exact fragment of the 2.10.4-era minified code, later an equivalent
   * module-factory rewrite).  We tried that too: the engine really did rewrite the target module on
   * the live client, but the rebuilt factory is created with `new Function(...)`, which drops the
   * original closure, and ONE module that resolves a free identifier then throws and takes the whole
   * app down (measured: blank window, #root 0 children).  Both rewrite rules now ship disabled --
   * see docs/11 section 8.
   *
   * This does the same job one layer out, where no code rewriting is needed at all.  Measured on the
   * live client: every HTTP request goes through the native bridge as
   *
   *     channel.call('network.fetch', cb, [{ url, method, headers, isDecrypt, body }])
   *  -> cb({ blob: "<decrypted JSON as a STRING>", code, headers, ... })
   *
   * and the lyric endpoints are `/api/song/lyric/v1` and `/api/cloud/lyric/get`.  So we wrap
   * channel.call, and for a lyric request we parse `blob`, hand the payload to the hook, and write
   * the hook's result back into `blob` before the app sees it.
   *
   * Advantages over rewriting: independent of the parser's minified shape (only the API path is
   * involved), no closure is lost, nothing is re-evaluated, and it is trivially reversible.
   */
  /* ------------------------------------------------------- DOM alias layer -- */
  /**
   * Give legacy plugins back the handful of anchors the 3.x frontend removed.
   *
   * Measured need: LyricBar mounts its bar by polling for `#main-player`
   * (`k("#main-player", cb)`) and never subscribes otherwise, so on 3.1.41 it loads and then does
   * nothing at all -- while its data source (RefinedNowPlayingNext's `lyrics-updated`) is working
   * fine.  Re-creating that one id turns a dead plugin into a working one, and it is far safer than
   * patching a 294 KB minified bundle.
   *
   * Everything here is additive (an id and a class) and re-applied on a slow timer, because React
   * re-renders can drop attributes it did not set.  Nothing is moved or removed.
   */
  function installDomAliases() {
    if (window.__BNCM_DOM_ALIASES__) return window.__BNCM_DOM_ALIASES__;
    var alias = { applied: false, target: null, playButtons: 0, attempts: 0 };

    /** Geometric fallback: the class names above are CSS-module hashes that drift, so also find
     *  the bar by shape -- locate play/pause controls in the lower part of the window and walk up
     *  to bar-shaped ancestors, then prefer the one sitting LOWEST on screen.  Simply taking the
     *  first match picked a content row (`exposure-bar`) that happened to be bar-shaped; choosing
     *  by position lands on the real player bar. */
    function pickByGeometry() {
      var btns = document.querySelectorAll(
        '[title*="播放"],[title*="暂停"],[aria-label*="播放"],[aria-label*="暂停"],[class*="PlayButton"]');
      var best = null, bestTop = -1;
      for (var i = 0; i < btns.length; i++) {
        var r0 = btns[i].getBoundingClientRect();
        // Must be VISIBLE in the viewport and in its lower part.  Checking only "top > half" picked
        // off-screen content rows on a scrolled page (measured: an `exposure-bar` at top 2079).
        if (!r0.width || r0.top < window.innerHeight * 0.6 || r0.top > window.innerHeight) continue;
        var el = btns[i];
        for (var up = 0; up < 8 && el; up++) {
          var r = el.getBoundingClientRect();
          if (r.width > window.innerWidth * 0.5 && r.height > 40 && r.height < 220) {
            if (r.top > bestTop) { bestTop = r.top; best = el; }
            break;
          }
          el = el.parentElement;
        }
      }
      return best;
    }

    function pickPlayerBar() {
      var cands = document.querySelectorAll(
        '[class*="DefaultPlayerContainer"], [class*="DefaultBarWrapper"], [class*="BarWrapper"], [class*="MiniBar"]');
      var best = null, bestScore = -1;
      for (var i = 0; i < cands.length; i++) {
        var el = cands[i];
        var r = el.getBoundingClientRect();
        if (r.width < 400 || r.height < 30) continue;
        // Prefer the widest one anchored in the lower half of the window (the player bar); the
        // mini bar is small and sits elsewhere.
        var score = r.width + (r.top > window.innerHeight / 2 ? 1000 : 0);
        if (score > bestScore) { bestScore = score; best = el; }
      }
      return best || pickByGeometry();
    }

    /** Create the mount gate when the client is in a layout that has no full-width player bar.
     *
     *  Needed because the client is not always in its full layout: measured with the mini bar
     *  showing, the only bar-ish elements were a 40x100 strip and three 40x20 chips, so there was
     *  nothing to alias and LyricBar stayed dormant.  LyricBar's actual requirement is tiny --
     *  `k("#main-player", cb)` is just "wait until this exists", the bar it builds is appended to
     *  document.body, and the element is also read for a `data-log` attribute.  It never uses the
     *  element's geometry, so a placeholder is a faithful stand-in. */
    function createMountGate() {
      var el = document.createElement('div');
      el.id = 'main-player';
      el.setAttribute('data-bncm-alias', 'placeholder');
      el.style.cssText = 'position:fixed;left:0;bottom:0;width:100%;height:0;pointer-events:none;';
      (document.body || document.documentElement).appendChild(el);
      return el;
    }

    function apply() {
      alias.attempts++;
      var holder = document.getElementById('main-player');
      var bar = pickPlayerBar();

      // A real player bar exists: use it (and upgrade away from a placeholder if we made one).
      if (bar) {
        if (holder === bar) { alias.applied = true; alias.target = bar; return true; }
        try {
          bar.id = 'main-player';
          bar.setAttribute('data-bncm-alias', 'false');
          if (!/(^|\s)m-player(\s|$)/.test(bar.className)) bar.className += ' m-player';
          var btns = bar.querySelectorAll('[class*="PlayButton"], .play-btn');
          for (var i = 0; i < btns.length; i++) {
            if (!/(^|\s)btnp(\s|$)/.test(btns[i].className)) btns[i].className += ' btnp';
            alias.playButtons++;
          }
          alias.applied = true;
          alias.synthetic = false;
          alias.target = bar;
          log('DOM alias: #main-player -> [' + String(bar.className).slice(0, 40) + '] (' +
              alias.playButtons + ' play button alias(es))');
          return true;
        } catch (e) {
          warn('DOM alias failed: ' + (e && e.message));
        }
      }

      // No usable player bar: make sure the gate exists so plugins can mount at all.
      if (!holder) {
        try {
          alias.target = createMountGate();
          alias.applied = true;
          alias.synthetic = true;
          log('DOM alias: #main-player -> placeholder (no player bar in this layout)');
          return true;
        } catch (e) {
          warn('DOM alias placeholder failed: ' + (e && e.message));
          return false;
        }
      }
      alias.applied = true;
      alias.synthetic = holder.getAttribute('data-bncm-alias') === 'placeholder';
      alias.target = holder;
      return true;
    }

    window.__BNCM_DOM_ALIASES__ = alias;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', apply, { once: true });
    } else {
      apply();
    }
    // React re-renders can strip the alias, and the player bar may not exist yet at boot.
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (!document.getElementById('main-player')) apply();
      // The client can REPLACE window.channel while it boots, which would leave our lyric wrapper
      // on a dead object.  Re-check rather than reporting a capability we no longer have.
      if (!lyricsFeed.verified) installLyricsFeed();
      watchLyricsPipeline();
      if (tries > 300) clearInterval(timer);      // ~5 minutes of patience, then stop
    }, 1000);
    return alias;
  }

  var lyricsFeed = { installed: false, requests: 0, processed: 0, errors: [], lastUrl: null,
                     skipped: 'not attempted' };

  /* Is RNP-Next's lyric pipeline actually working?
   *
   * Measured on 3.1.41: it is, and NOT through the mechanism RNP asks for.  Wrapping
   * window.onProcessLyrics showed the client never calls it (`nativeCalls` stayed 0 while
   * `window.currentLyrics` filled with 43 lines), and window.rnpDispatchHook is an alternative
   * entry to the SAME `sn()` processing function.  RNP-Next 3.x fetches and processes lyrics
   * through its own client-side path, so both manifest hijacks (the 2.10.4 parser replace and the
   * 3.1.11 redux hook) are legacy requirements this client does not need.
   *
   * RNP still gates a "hijack failed, lyrics may not display" notice on getSucceededHijacks(),
   * which -- because we apply no rewrite -- is empty, so it warns about a problem that does not
   * exist here.  The fix is to report the capability that IS real, and to record it as evidence:
   * we watch the lyric pipeline actually produce output.  RNP checks at load time, before any song
   * has played, so the observation is persisted and holds on later loads too. */
  var lyricsPipelineProven = false;
  var lyricsPipelineLines = null;
  var pipelineListenerAdded = false;
  var PIPELINE_KEY = '__bncm_lyrics_pipeline__';
  try { lyricsPipelineProven = window.localStorage.getItem(PIPELINE_KEY) === '1'; } catch (e) { /* ignore */ }

  function notePipeline(lines) {
    if (lines > 0) { lyricsPipelineLines = lines; }
    lyricsPipelineProven = true;
    try { window.localStorage.setItem(PIPELINE_KEY, '1'); } catch (e) { /* ignore */ }
  }

  function watchLyricsPipeline() {
    if (!pipelineListenerAdded) {
      pipelineListenerAdded = true;
      // RNP-Next dispatches this the moment it finishes processing a song's lyrics, and LyricBar
      // consumes it -- so it is positive proof the whole chain works.
      document.addEventListener('lyrics-updated', function (ev) {
        var n = (ev && ev.detail && ev.detail.lyrics) ? ev.detail.lyrics.length : 0;
        notePipeline(n);
      });
    }
    if (window.currentLyrics && window.currentLyrics.lyrics && window.currentLyrics.lyrics.length) {
      notePipeline(window.currentLyrics.lyrics.length);
    }
  }

  function installLyricsFeed() {
    if (window.__BNCM_LYRICS_FEED__ && window.__BNCM_LYRICS_FEED__.verified) {
      lyricsFeed = window.__BNCM_LYRICS_FEED__;
      return true;
    }
    var ch = window.channel;
    if (!ch || typeof ch.call !== 'function') { lyricsFeed.skipped = 'window.channel not available'; return false; }
    // Never wrap twice: re-wrapping would stack another hook call per request.
    if (String(ch.call).indexOf('__bncmLyricsFeed') !== -1) {
      lyricsFeed.installed = true; lyricsFeed.verified = true;
      window.__BNCM_LYRICS_FEED__ = lyricsFeed;
      return true;
    }

    var orig = ch.call.bind(ch);
    // The function NAME is the verification marker: installLyricsFeed() checks for it rather than
    // trusting a boolean, so `installed` can only be true when the wrapper is really in place.
    var __bncmLyricsFeed = function (cmd, cb, args) {
      var url = null;
      try {
        if (cmd === 'network.fetch' && args && args[0] && typeof args[0].url === 'string') url = args[0].url;
      } catch (e) { /* ignore */ }
      if (!url || !/\/api\/(song\/lyric|cloud\/lyric)/.test(url)) return orig(cmd, cb, args);

      lyricsFeed.requests++;
      lyricsFeed.lastUrl = url;
      var wrapped = function (res) {
        try {
          if (res && typeof res.blob === 'string' && res.blob.length) {
            var payload = JSON.parse(res.blob);
            var hook = window.onProcessLyrics;
            if (typeof hook === 'function') {
              var out = hook(payload, payload && payload.source);
              if (out && typeof out === 'object') res.blob = JSON.stringify(out);
              lyricsFeed.processed++;
            } else {
              // RNP not installed yet (or declined): pass the response through untouched.
              lyricsFeed.errors.push('hook absent for ' + url);
            }
          }
        } catch (e) {
          // Never break the client's lyric path, whatever a plugin's hook does.
          lyricsFeed.errors.push((e && e.message) || String(e));
          if (lyricsFeed.errors.length > 20) lyricsFeed.errors.shift();
          warn('lyrics feed: ' + (e && e.message));
        }
        return cb && cb.apply(this, arguments);
      };
      return orig(cmd, wrapped, args);
    };
    ch.call = __bncmLyricsFeed;

    // VERIFY the assignment actually took.  The first implementation set `installed = true`
    // unconditionally, and on the live client the wrapper was not in place (measured:
    // channel.call was writable, yet String(channel.call) did not contain the wrapper) -- i.e. the
    // flag lied.  A loader that claims to be active while doing nothing is the one failure mode
    // this project refuses to ship, so the flag is derived from the object itself.
    lyricsFeed.installed = String(ch.call).indexOf('__bncmLyricsFeed') !== -1;
    lyricsFeed.verified = lyricsFeed.installed;
    if (!lyricsFeed.installed) lyricsFeed.skipped = 'window.channel.call could not be wrapped';
    window.__BNCM_LYRICS_FEED__ = lyricsFeed;
    log(lyricsFeed.installed
      ? 'lyrics feed installed (intercepting network.fetch lyric requests)'
      : 'lyrics feed NOT installed: ' + lyricsFeed.skipped);
    return lyricsFeed.installed;
  }

  var ncm = {    version: ncmAppver(),
    get channel() { return window.channel || null; },
    channelFunctions: window.channel ? Object.keys(window.channel).sort() : [],
    /** Call a native bridge command.
     *
     *  The bridge callback can receive MORE THAN ONE argument, and dropping the extras silently
     *  broke real features.  Measured on 3.1.41:
     *
     *      channel.call('os.querySystemFonts', cb, [])
     *        -> cb('success', ['Ebrima','Gadugi','Malgun Gothic', ... 82 names])
     *      channel.call('os.checkNativeSupportFonts', cb, ['Microsoft YaHei'])
     *        -> cb('success', undefined)
     *
     *  Resolving `arguments[0]` (as this used to) therefore handed every caller the string
     *  "success" instead of the value it asked for: a plugin enumerating the system fonts got the
     *  string "success" and fell back to a hand-written list.
     *
     *  The client's own convention, which plugin code in the wild already assumes, is
     *  `r.length > 1 ? r : r[0]`: a multi-value reply arrives as the raw argument list, a
     *  single-value reply as the value itself. */
    call: function (command) {
      var args = Array.prototype.slice.call(arguments, 1);
      return new Promise(function (resolve) {
        if (!window.channel || typeof window.channel.call !== 'function') return resolve(undefined);
        try {
          window.channel.call(command, function () {
            var a = Array.prototype.slice.call(arguments);
            resolve(a.length > 1 ? a : a[0]);
          }, args);
        } catch (e) { resolve(undefined); }
      });
    },
    /** Like call(), but always resolves the raw argument list (for diagnostics/tests). */
    callRaw: function (command) {
      var args = Array.prototype.slice.call(arguments, 1);
      return new Promise(function (resolve) {
        if (!window.channel || typeof window.channel.call !== 'function') return resolve([]);
        try {
          window.channel.call(command, function () {
            resolve(Array.prototype.slice.call(arguments));
          }, args);
        } catch (e) { resolve([]); }
      });
    },
    on: function (event, handler) {
      if (!window.channel || typeof window.channel.registerCall !== 'function') return function () {};
      try { window.channel.registerCall(event, handler); } catch (e) { return function () {}; }
      return function () {};
    },
    getNCMVersion: function () { return ncm.version; },
    openUrl: function (url) {
      // The client owns the platform opener; same command its own UI uses.
      return ncm.call('os.navigateExternal', String(url)).then(function () { return true; },
        function () { window.open(url, '_blank'); return true; });
    },
    getPlayingSong: function () {
      // Not every bridge command reports a value (see docs/03-native-bridge.md §6), so fall
      // back to the player command the page itself uses and tolerate undefined.
      return ncm.call('player.getPlayingSong').then(function (r) { return r === undefined ? null : r; });
    },
    /** SYNCHRONOUS current-song accessor.
     *
     *  This must not return a promise.  RefinedNowPlaying calls
     *  `betterncm.ncm.getPlaying().id` in the middle of its lyrics pipeline; upstream's
     *  getPlaying() is a deprecated synchronous helper, so an async implementation would
     *  produce `undefined.id` and abort every lyric-processing run.
     *
     *  Resolution order:
     *    1. the client's own getPlaying()/getPlayingSong(), found through the webpack module
     *       cache (that is what upstream's findApiFunction did);
     *    2. a cache kept fresh by the player bridge events and a slow poll;
     *    3. an empty-but-shaped object, never null.
     */
    getPlaying: function () {
      try {
        var fn = ncm.findApiFunction('getPlaying') || ncm.findApiFunction('getPlayingSong');
        if (typeof fn === 'function') {
          var v = fn();
          if (v && typeof v === 'object' && v.id !== undefined) { playingCache.song = v; return v; }
        }
      } catch (e) { /* fall through to the cache */ }
      return playingCache.song || { id: '', title: '', type: 0 };
    },
    /** Upstream's findApiFunction: reach into the client's webpack module cache and return the
     *  first exported function with this name.  Possible only because the document-start
     *  preload captures `__webpack_require__` (see tools/bncm_preload.js). */
    findApiFunction: function (name) {
      try {
        var wp = window.__BNCM_WP__;
        if (!wp || !wp.cache) return null;
        var cache = wp.cache, keys = Object.keys(cache);
        for (var i = 0; i < keys.length; i++) {
          var mod = cache[keys[i]];
          var exp = mod && mod.exports;
          if (!exp) continue;
          var v = exp[name];
          if (typeof v === 'function') return v.bind(exp);
          // Namespaced export objects (webpack harmony modules) are common in this bundle.
          if (typeof exp === 'object' && exp !== null) {
            var sub = exp.default;
            if (sub && typeof sub[name] === 'function') return sub[name].bind(sub);
          }
        }
      } catch (e) { /* ignore */ }
      return null;
    },
  };

  /* -------------------------------------------------------------- utils ---- */
  // Ported faithfully from upstream BetterNCM/js-framework src/betterncm-api/utils.ts.
  // Note waitForElement polls FOREVER and never rejects (upstream semantics); plugins rely on
  // that -- rejecting after a timeout breaks awaits that are merely waiting for a slow page.
  var utils = {
    waitForElement: function (selector, interval) {
      return utils.waitForFunction(function () { return document.querySelector(selector); },
                                   interval === undefined ? 100 : interval);
    },
    waitForFunction: function (func, interval) {
      return new Promise(function (resolve) {
        var handle = setInterval(function () {
          var result;
          try { result = func(); } catch (e) { return; }
          if (result) { clearInterval(handle); resolve(result); }
        }, interval === undefined ? 100 : interval);
      });
    },
    debounce: function (callback, waitTime) {
      var timer = 0;
      return function () {
        var self = this, args = arguments;
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () { callback.apply(self, args); }, waitTime);
      };
    },
    delay: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
    /** Hyperscript helper. Upstream exposes this as window.dom; many plugins call dom(). */
    dom: function (tag, settings) {
      var children = Array.prototype.slice.call(arguments, 2);
      var el = document.createElement(tag);
      settings = settings || {};
      if (settings.class) {
        if (typeof settings.class === 'string') el.className = settings.class;
        else for (var i = 0; i < settings.class.length; i++) {
          if (settings.class[i]) el.classList.add(settings.class[i]);
        }
        delete settings.class;
      }
      if (settings.style) {
        for (var k in settings.style) {
          if (Object.prototype.hasOwnProperty.call(settings.style, k)) el.style[k] = settings.style[k];
        }
        delete settings.style;
      }
      for (var v in settings) {
        if (Object.prototype.hasOwnProperty.call(settings, v) && settings[v]) el[v] = settings[v];
      }
      for (var c = 0; c < children.length; c++) {
        if (children[c]) el.appendChild(children[c]);
      }
      return el;
    },
    /** Extra helper (not upstream): inject a stylesheet with an id so it is idempotent. */
    appendStyle: function (css, id) {
      if (id && document.getElementById(id)) return;
      var s = document.createElement('style');
      if (id) s.id = id;
      s.textContent = css;
      (document.head || document.documentElement).appendChild(s);
    },
  };

  var path = {
    join: function () {
      return Array.prototype.slice.call(arguments)
        .map(function (s, i) { return i === 0 ? String(s).replace(/[\\/]+$/, '') : String(s).replace(/^[\\/]+|[\\/]+$/g, ''); })
        .filter(Boolean).join('\\');
    },
    basename: function (p) { return String(p).split(/[\\/]/).pop(); },
    extname: function (p) { var b = String(p).split(/[\\/]/).pop(); var i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i); },
  };

  var loadedPlugins = [];

  /* ------------------------------------------------------- load telemetry ---- */
  /**
   * Per-plugin timing, published as window.__BNCM_LOADED__.perf and read by betterncm.loader.
   *
   * Why this exists: "the client got slow after I installed a plugin" is unanswerable without
   * knowing WHICH plugin, and with N plugins loaded through one shared chain it is easy for a
   * single bad one to be invisible.  Everything the loader can measure itself is recorded here --
   * download wait, evaluation, lifecycle hooks -- plus the page errors that happen while a plugin
   * is the active one, so blame lands on a slug rather than on "a plugin".
   */
  var loadPerf = {
    build: BUILD,
    started_at: null, finished_at: null, total_ms: null,
    plugins: 0, loaded: 0, error: 0, skipped: 0,
    fetches: 0, fetched_bytes: 0, failed_fetches: 0,
    planned_scripts: 0, skipped_scripts: 0,
    fetch_phase_ms: null, eval_ms: 0, hook_ms: 0,
    concurrency: LOADER.concurrency, yields: 0,
    timeouts: [], failures: [], slow: [], page_errors: [],
    per_plugin: [],
  };
  var activeSlug = null;

  function noteSlow(slug, phase, ms) {
    if (ms >= LOADER.slowHookMs) {
      loadPerf.slow.push({ slug: slug, phase: phase, ms: Math.round(ms) });
      warn('slow ' + phase + ' hook: ' + slug + ' took ' + Math.round(ms) + 'ms (budget ' + LOADER.slowHookMs + 'ms)');
    }
  }

  /** Attribute a page error to whichever plugin was active when it happened.
   *
   *  A plugin that throws asynchronously cannot be caught by the loader's try/catch -- the error
   *  surfaces on window.  Recording it against the active slug turns "something is broken" into
   *  "this plugin's code broke the page", which is the difference between a bug report and a fix. */
  function initPageErrorCapture() {
    if (window.__BNCM_PAGE_ERRORS__) return;
    var list = [];
    window.__BNCM_PAGE_ERRORS__ = list;
    function record(kind, message, stack) {
      if (list.length >= 50) list.shift();
      var entry = { kind: kind, slug: activeSlug, message: String(message || '').slice(0, 500),
                    stack: String(stack || '').slice(0, 2000), at: Date.now() };
      list.push(entry);
      loadPerf.page_errors.push(entry);
    }
    try {
      window.addEventListener('error', function (ev) {
        record('error', (ev && (ev.message || (ev.error && ev.error.message))) || 'unknown error',
               ev && ev.error && ev.error.stack);
      });
      window.addEventListener('unhandledrejection', function (ev) {
        var r = ev && ev.reason;
        record('unhandledrejection', (r && (r.message || r)) || 'unhandled rejection', r && r.stack);
      });
    } catch (e) { /* ignore */ }
  }

  /**
   * Upstream publishes NCMPlugin/NCMInjectPlugin OBJECTS here, not internal bookkeeping.  The old
   * implementation returned the loader's own result records, so `plugin.get(slug)` gave back an
   * object without `_getConfigElement`, `mainPlugin` or the lifecycle API -- which silently broke
   * every caller that reaches for a plugin's settings view.  That includes our own manager, whose
   * config pane would have shown “该插件没有提供设置项” for every plugin.
   *
   * `getAll()` therefore returns contexts, and `get(slug)` returns a context or null.  The
   * loader's records remain reachable as `ctx._result` for diagnostics.
   */
  var plugin = {
    getAll: function () {
      return loadedPlugins
        .filter(function (r) { return r.state === 'loaded' || r.state === 'pending'; })
        .map(function (r) { return r.ctx; });
    },
    get: function (slug) {
      var hit = loadedPlugins.filter(function (p) { return p.slug === slug; })[0];
      if (hit) return hit.ctx;
      // Fall back to the manifest slug, which can differ from the file name for .plugin archives
      // that omit a `slug` field.
      hit = loadedPlugins.filter(function (p) {
        return p.ctx && p.ctx.manifest && p.ctx.manifest.slug === slug;
      })[0];
      return hit ? hit.ctx : null;
    },
  };

  /* ------------------------------------------------------------ loader */

  /**
   * React shim, ported from upstream js-framework src/betterncm-api/react.ts.
   *
   * NetEase's page is a React app and exposes React globally.  Upstream waits for it and then
   * sets window.h = React.createElement and window.f = React.Fragment, because several real
   * plugins (LibFrontendPlay, SimpleAudioVisualizer, StyleSnippet) are React bundles that
   * reference the bare globals h/f.
   *
   * We expose this as a promise and make plugin loading await it: upstream starts the wait
   * concurrently with plugin loading, which races.  Awaiting removes the race.
   */
  var reactReady = new Promise(function (resolve) {
    function tryInit() {
      if ('React' in window && window.React &&
          'createElement' in window.React && 'Fragment' in window.React) {
        window.h = window.React.createElement;
        window.f = window.React.Fragment;
        return true;
      }
      return ('h' in window) && ('f' in window);
    }
    if (tryInit()) { log('React shim ready (window.h / window.f)'); return resolve(true); }
    utils.waitForFunction(tryInit, 100).then(function () {
      log('React shim ready (window.h / window.f)');
      resolve(true);
    });
    // Never block plugin loading forever if this client stops exposing React globally.
    setTimeout(function () {
      if (!('h' in window)) {
        warn('React not found on window after 15s; h/f unavailable — React-based plugins will fail');
      }
      resolve(false);
    }, 15000);
  });
  function configToolBox() {
    return {
      makeBtn: function (text, onClick, smaller, args) {
        return utils.dom('a', Object.assign({
          class: ['u-ibtn5', smaller && 'u-ibtnsz8'],
          style: { margin: '.2em .5em' },
          innerText: text,
          onclick: onClick,
        }, args || {}));
      },
      makeCheckbox: function (args) { return utils.dom('input', Object.assign({ type: 'checkbox' }, args || {})); },
      makeInput: function (value, args) {
        return utils.dom('input', Object.assign({
          value: value,
          style: { margin: '.2em .5em', borderRadius: '.5em' },
          class: ['u-txt', 'sc-flag'],
        }, args || {}));
      },
    };
  }

  /**
   * The `plugin` object a plugin sees, ported from upstream BetterNCM/js-framework
   * src/plugin.ts (class NCMInjectPlugin).  Crucially these are REGISTRATION functions, not
   * settable properties: plugins write `plugin.onLoad(cb)`, `plugin.onConfig(cb)`,
   * `plugin.onAllPluginsLoaded(cb)`.  The loader later dispatches the corresponding event.
   *
   * getConfig/setConfig are key/value and persisted in localStorage under
   * `config.betterncm.<slug>` exactly as upstream does -- not whole-object writes.
   */
  /** Copy EventTarget's API onto a plain object so it can be used as an EventTarget.
   *  Upstream's NCMInjectPlugin and NCMPlugin both `extends EventTarget`, and plugins call
   *  plugin.addEventListener / plugin.mainPlugin.addEventListener directly. */
  function makeEventTargetish(obj, target) {
    ['addEventListener', 'removeEventListener', 'dispatchEvent'].forEach(function (m) {
      obj[m] = target[m].bind(target);
    });
    return obj;
  }

  function makePluginContext(m) {
    var target = new EventTarget();
    var inject = makeEventTargetish({
      pluginPath: m.slug,
      manifest: m,
      finished: false,
      loadError: null,
      configViewElement: null,
      mainPlugin: null,
      _target: target,

      onLoad: function (fn) {
        target.addEventListener('load', function (evt) {
          try { fn.call(inject, evt.detail, evt); }
          catch (e) { inject.loadError = e; warn(m.slug + '.onLoad threw: ' + (e && e.message)); }
        });
      },
      onConfig: function (fn) {
        target.addEventListener('config', function (evt) {
          try { inject.configViewElement = fn.call(inject, evt.detail); }
          catch (e) { warn(m.slug + '.onConfig threw: ' + (e && e.message)); }
        });
      },
      onAllPluginsLoaded: function (fn) {
        target.addEventListener('allpluginsloaded', function (evt) {
          try { fn.call(inject, evt.detail, evt); }
          catch (e) { warn(m.slug + '.onAllPluginsLoaded threw: ' + (e && e.message)); }
        });
      },

      getConfig: function (key, defaultValue) {
        try {
          var cfg = JSON.parse(localStorage.getItem('config.betterncm.' + m.slug) || '{}');
          if (cfg && cfg[key] !== undefined) return cfg[key];
        } catch (e) { /* fall through to default */ }
        return defaultValue;
      },
      setConfig: function (key, value) {
        var cfg = null;
        try { cfg = JSON.parse(localStorage.getItem('config.betterncm.' + m.slug) || '{}'); } catch (e) { cfg = null; }
        if (!cfg || typeof cfg !== 'object') cfg = Object.create(null);
        cfg[key] = value;
        localStorage.setItem('config.betterncm.' + m.slug, JSON.stringify(cfg));
      },

      haveConfigElement: function () { return inject.configViewElement !== null; },
      _getConfigElement: function () {
        if (!inject.configViewElement) {
          target.dispatchEvent(new CustomEvent('config', { detail: configToolBox() }));
        }
        return inject.configViewElement;
      },
    }, target);

    // mainPlugin is an NCMPlugin upstream (also an EventTarget), and plugins attach methods
    // and listeners to it (PluginMarket 0.8.4, LibFrontendPlay 1.1.0).
    var mainTarget = new EventTarget();
    inject.mainPlugin = makeEventTargetish({
      pluginPath: m.slug,
      manifest: m,
      injects: [inject],
      finished: false,
      haveConfigElement: function () { return inject.configViewElement !== null; },
      _target: mainTarget,
    }, mainTarget);
    inject._mainTarget = mainTarget;

    // `devMode` is TRUE exactly for a plugin served by a dev source (betterncm.dev), because that
    // is the only thing an author can rely on: it tells the plugin "you are running unpackaged,
    // from <dir>, and the loader may hot-reload you".  Upstream hard-codes false here, which is
    // why plugin-side dev branches never ran.  A getter keeps it correct even when a plugin
    // caches the object before its `load` event.
    Object.defineProperty(inject, 'devMode', {
      get: function () { return !!(inject._result && inject._result.dev === true); },
      enumerable: true, configurable: true,
    });
    Object.defineProperty(inject.mainPlugin, 'devMode', {
      get: function () { return !!(inject._result && inject._result.dev === true); },
      enumerable: true, configurable: true,
    });

    return inject;
  }

  function runScript(code, name, ctx) {
    // `plugin` is passed as a real function parameter, not just a window global.
    //
    // This matters: plugins register callbacks (plugin.onLoad(function () { plugin.mainPlugin
    // ... })) that run long after evaluation.  As a parameter, the binding is captured by the
    // closure, so those callbacks see their own plugin object even though `window.plugin` has
    // moved on.  PluginMarket 0.8.4 fails without this ("Cannot read property 'mainPlugin' of
    // undefined").  window.plugin is still set during evaluation for explicit global lookups.
    var prevPlugin = window.plugin;
    var prevActive = activeSlug;
    activeSlug = (ctx && ctx.pluginPath) || null;
    window.plugin = ctx;
    var t0 = nowMs();
    try {
      var fn = new Function('betterncm', 'require', 'plugin', code + '\n//# sourceURL=' + name);
      fn(window.betterncm, function (id) {                     // minimal CommonJS `require`
        return {
          betterncm: window.betterncm,
        }[id] || (function () { throw new Error('require("' + id + '") is not supported'); })();
      }, ctx);
      return { ok: true, ms: nowMs() - t0 };
    } catch (e) {
      warn('plugin script failed: ' + name + ' :: ' + (e && e.message));
      return { ok: false, error: String(e && e.message), ms: nowMs() - t0 };
    } finally {
      window.plugin = prevPlugin;
      activeSlug = prevActive;
    }
  }

  /** Decide, from the manifest alone, whether a plugin will actually be loaded.
   *
   *  Shared by the scheduler (which must not download scripts for plugins that will be skipped)
   *  and by loadPlugin (the single place that records the decision), so the two can never disagree.
   *  Returns null when the plugin loads, {reason} when it is skipped, {unverified:true} when it
   *  loads but its client-version requirement could not be checked. */
  function pluginGate(p, isCore) {
    var m = p.manifest;
    if (m.manifest_version !== 1) {
      return { reason: 'unsupported manifest_version ' + m.manifest_version };
    }
    // A core plugin is built in: it is loaded unconditionally.  The 3.x gate and the
    // ncm-version-req range exist to protect the user from plugins that were never checked
    // against this client -- both checks were applied to the built-ins when they were
    // adopted, and re-applying them here would only mean a pack update could silently
    // switch off a feature the user cannot turn back on.  The disabled list is ignored for
    // the same reason (and the host refuses to write such an entry at all).
    if (isCore) return null;
    if (STRICT_NCM3 && m.ncm3_compatible !== true) {
      return { reason: 'ncm3-compatible not declared (strict gate)' };
    }
    // Tri-state: only an explicit false skips.  Absent means "not declared", which for real
    // plugins is the common case (17 of 22) and must still load.
    if (m.ncm3_compatible === false) {
      return { reason: 'manifest declares ncm3-compatible: false' };
    }
    // Version gate.  Deliberately FAIL-OPEN when the client version cannot be determined.
    // The old code did `if (!satisfies(ncm.version, req)) skip`, which on 3.1.41 meant
    // `satisfies(null, '> 3.0.0')` -> false -> every version-constrained plugin was silently
    // disabled, reported as "ncm-version-req > 3.0.0 not satisfied by null".  An unknown
    // version is OUR blindness, not evidence that the plugin is incompatible, so the plugin
    // loads and is marked unverified.
    if (ncm.version) {
      if (!satisfies(ncm.version, m.ncm_version_req)) {
        return { reason: 'ncm-version-req ' + m.ncm_version_req + ' not satisfied by ' + ncm.version };
      }
    } else if (m.ncm_version_req && m.ncm_version_req !== '*') {
      return { unverified: true };
    }
    if (p.disabled) return { reason: 'disabled by the user' };
    return null;
  }

  function loadPlugin(p, isCore, prefetched) {
    var m = p.manifest;
    var ctx = makePluginContext(m);
    var result = {
      slug: m.slug, name: m.name, version: m.version, author: m.author,
      type: m.type, state: 'pending', scripts: [], error: null,
      ncm3_compatible: m.ncm3_compatible, core: !!isCore, ctx: ctx,
      disabled: !!p.disabled, dev: p.dev === true,
      dev_source: p.dev_source || null, manifest: m,
      hooks: { onLoad: false, onConfig: false, onAllPluginsLoaded: false },
    };
    loadedPlugins.push(result);
    // Keep the loader's own record reachable from the context: plugin.get() now returns contexts
    // (upstream semantics), and diagnostics still need the record's state/error.
    ctx._result = result;

    /** Skip this plugin (gate / disabled) and publish the snapshot, so a skip is progress too. */
    function skip(reason) {
      result.state = 'skipped'; result.error = reason;
      publishPluginStates();
      return result;
    }

    var gate = pluginGate(p, isCore);
    if (gate && gate.reason) return skip(gate.reason);
    if (gate && gate.unverified) {
      result.ncm_version_unverified = true;
      warn('client version unknown; loading ' + m.slug + ' without checking ncm-version-req ' +
           m.ncm_version_req + ' (marked unverified)');
    }

    // injects["Main"] is the /pub/app.html bucket; also accept raw path keys.
    var files = [];
    var bucket = m.injects && (m.injects.Main || m.injects['/pub/app.html']);
    if (Array.isArray(bucket)) {
      bucket.forEach(function (it) { if (it && it.file) files.push(it.file.replace(/^\.\//, '')); });
    }

    result.scripts = files;

    var perf = {
      slug: m.slug, core: !!isCore, state: 'pending', scripts: files.length,
      fetch_ms: 0, server_ms: 0, eval_ms: 0, hook_ms: 0, load_ms: 0, bytes: 0,
      timed_out: false, slow: false,
    };
    loadPerf.per_plugin.push(perf);
    result.perf = perf;
    var loadT0 = nowMs();

    /** One script body, already in flight (see startPrefetch) or fetched here as a fallback. */
    function body(i) {
      var f = files[i];
      if (prefetched && prefetched[i]) return prefetched[i];
      return fetchScript({ slug: m.slug, file: f });
    }

    var fetchT0 = nowMs();
    result.state = 'loading';
    return Promise.all(files.map(function (f, i) { return body(i); })).then(function (got) {
      perf.fetch_ms = nowMs() - fetchT0;
      perf.server_ms = got.reduce(function (a, g) { return a + ((g && g.ms) || 0); }, 0);
      perf.bytes = got.reduce(function (a, g) { return a + ((g && g.code) ? g.code.length : 0); }, 0);
      loadPerf.fetched_bytes += perf.bytes;
      for (var i = 0; i < got.length; i++) {
        var g = got[i];
        if (g && g.ok) continue;
        var why = (g && g.error) || 'script fetch failed';
        perf.timed_out = !!(g && g.timed_out);
        if (perf.timed_out) { loadPerf.timeouts.push(m.slug); result.timed_out = true; }
        loadPerf.failed_fetches++;
        loadPerf.failures.push({ slug: m.slug, file: files[i], error: why });
        result.error = why;
        break;
      }
      if (result.error) return null;
      // Evaluate strictly in order: plugins share window.plugin and the document, and their
      // loadAfter ordering only means anything if scripts run in the planned sequence.
      for (var j = 0; j < got.length; j++) {
        var r = runScript(got[j].code, 'bncm-plugin://' + m.slug + '/' + files[j], ctx);
        perf.eval_ms += r.ms || 0;
        loadPerf.eval_ms += r.ms || 0;
        if (!r.ok) { result.error = r.error; break; }
      }
      return null;
    }).then(function () {
      // Dispatch the `load` event: this is what fires the callbacks plugins registered via
      // plugin.onLoad(cb).  Upstream does the same from the native side.
      if (!result.error) {
        var hookT0 = nowMs();
        dispatchPluginEvent(ctx, 'load', ctx);
        result.hooks.onLoad = !ctx.loadError;
        // Ask for the settings element NOW.  Upstream does this lazily, when the manager first
        // renders the plugin, which is why every plugin used to report onConfig:false -- the
        // `config` event was simply never dispatched and plugin.onConfig never ran.  Building
        // the element eagerly is safe (it is what the manager does anyway) and makes the
        // report truthful.
        try { ctx._getConfigElement(); } catch (e) { warn(m.slug + ' config element threw: ' + (e && e.message)); }
        result.hooks.onConfig = ctx.configViewElement !== null && ctx.configViewElement !== undefined;
        if (ctx.loadError) result.error = String(ctx.loadError && ctx.loadError.message);
        perf.hook_ms = nowMs() - hookT0;
        loadPerf.hook_ms += perf.hook_ms;
        noteSlow(m.slug, 'hook', perf.hook_ms);
        if (perf.hook_ms >= LOADER.slowHookMs) perf.slow = true;
      }
      perf.load_ms = nowMs() - loadT0;
      if (perf.load_ms >= LOADER.slowLoadMs) {
        perf.slow = true;
        loadPerf.slow.push({ slug: m.slug, phase: 'load', ms: Math.round(perf.load_ms) });
        warn('slow plugin load: ' + m.slug + ' took ' + Math.round(perf.load_ms) + 'ms');
      }
      result.state = result.error ? 'error' : 'loaded';
      perf.state = result.state;
      result.registered = registerWithNcmUi(result);
      publishPluginStates();
      log('plugin ' + m.slug + (isCore ? ' [core]' : '') + ' -> ' + result.state +
          ' in ' + Math.round(perf.load_ms) + 'ms (fetch ' + Math.round(perf.fetch_ms) +
          ', eval ' + Math.round(perf.eval_ms) + ', hooks ' + Math.round(perf.hook_ms) + ')' +
          (result.error ? ' (' + result.error + ')' : ''));
      return result;
    }, function (err) {
      perf.load_ms = nowMs() - loadT0;
      perf.state = 'error';
      result.state = 'error'; result.error = String(err && err.message);
      log('plugin ' + m.slug + ' -> error (' + result.error + ')');
      return result;
    });
  }

  /* ----------------------------------------------------- script fetching ---- */
  /**
   * Fetch one plugin script with a deadline.
   *
   * NEVER rejects: it resolves to {ok:false,...} so that a dead download is a result the loader can
   * report and move past, not an exception that unwinds a shared chain.  The AbortController is the
   * part that matters -- without it a request that never answers stays pending forever, and the
   * plugin (plus everything queued behind it) never loads.
   */
  function fetchScript(src) {
    var t0 = nowMs();
    var url = API + '/api/plugin/' + encodeURIComponent(src.slug) + '/' + src.file;
    var ctrl = null, timer = null;
    var opts = { headers: hdr() };
    try {
      if (typeof AbortController === 'function') {
        ctrl = new AbortController();
        opts.signal = ctrl.signal;
        timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* ignore */ } },
                           LOADER.fetchTimeoutMs);
      }
    } catch (e) { ctrl = null; }
    var clear = function () { if (timer) { clearTimeout(timer); timer = null; } };
    return fetch(url, opts).then(function (r) {
      clear();
      if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching ' + src.file);
      return r.text();
    }).then(function (code) {
      return { ok: true, code: code, ms: nowMs() - t0, url: url };
    }, function (err) {
      clear();
      var msg = String((err && err.message) || err);
      var aborted = (err && err.name === 'AbortError') || /abort/i.test(msg);
      return {
        ok: false, url: url, ms: nowMs() - t0, timed_out: aborted,
        error: aborted ? ('timeout after ' + LOADER.fetchTimeoutMs + 'ms fetching ' + src.file)
                       : ('fetch failed: ' + msg),
      };
    });
  }

  /**
   * Start a bounded pool over every script the loader is about to need.
   *
   * Downloads are independent of evaluation, so they all start now, `concurrency` at a time.  Each
   * returned promise settles with that single script's result, which lets the sequential evaluation
   * pass begin as soon as plugin #1's body is in hand instead of waiting for the whole set: a
   * single slow plugin costs its own slot, not the boot.
   */
  function startPrefetch(sources, limit) {
    var promises = [], resolvers = [];
    // Deferreds, created up front: the evaluation pass may await plugin #50 before the pool has
    // reached it, and it must await THIS script's real result rather than start a second download.
    for (var i = 0; i < sources.length; i++) {
      (function () {
        promises.push(new Promise(function (res) { resolvers.push(res); }));
      })();
    }
    var next = 0, active = 0, settled = 0, doneResolve = null;
    var allDone = new Promise(function (res) { doneResolve = res; });
    var startedAt = nowMs();
    function finish() {
      active--; settled++;
      if (settled >= sources.length) {
        loadPerf.fetches = sources.length;
        loadPerf.fetch_phase_ms = nowMs() - startedAt;
        doneResolve({ ms: loadPerf.fetch_phase_ms, fetches: sources.length });
        return;
      }
      pump();
    }
    function slot(i) {
      active++;
      // fetchScript() is written not to reject, but a host that throws synchronously (a stubbed
      // fetch, an exotic CEF build) must not leave a slot occupied forever -- that is the exact
      // failure mode this pool exists to remove, so it cannot be reintroduced by the entry point.
      var p;
      try { p = fetchScript(sources[i]); }
      catch (e) { p = Promise.resolve({ ok: false, ms: 0, error: 'fetch threw: ' + (e && e.message) }); }
      p.then(function (r) { resolvers[i](r); }).then(finish);
    }
    function pump() {
      while (active < limit && next < sources.length) slot(next++);
    }
    if (!sources.length) {
      loadPerf.fetches = 0;
      loadPerf.fetch_phase_ms = 0;
      doneResolve({ ms: 0, fetches: 0 });
    } else {
      pump();
    }
    return { promises: promises, allDone: allDone, startedAt: startedAt };
  }


  /** Dispatch a lifecycle event on both the inject plugin and its mainPlugin, mirroring
   *  upstream where NCMPlugin re-dispatches `load`/`allpluginsloaded` to each inject. */
  function dispatchPluginEvent(ctx, type, detail) {
    var evt = new CustomEvent(type, { detail: detail });
    try { ctx._target.dispatchEvent(evt); } catch (e) { warn(type + ' dispatch threw: ' + (e && e.message)); }
    if (ctx._mainTarget) {
      try { ctx._mainTarget.dispatchEvent(new CustomEvent(type, { detail: detail })); }
      catch (e) { /* ignore */ }
    }
  }

  /** Second pass: upstream's `allpluginsloaded`.  window.loadedPlugins is set first because
   *  plugins read it from inside the callback.
   *
   *  SHAPE MATTERS.  Upstream's loadedPlugins is an object keyed by slug; three plugins in this
   *  repo do `loadedPlugins.MaterialYouTheme`, `loadedPlugins.RefinedNowPlaying.manifest.version`
   *  and `loadedPlugins.LibFrontendPlay`.  An earlier implementation published a plain array, so
   *  every one of those probes silently read `undefined` -- which is exactly how "LyricBar keeps
   *  adding no-material-you-theme even though the theme is loaded" happens.
   *
   *  Both shapes are therefore provided: the array (`.length`, `.map`, `.filter`, `for...of`,
   *  which other plugins use) with the slug-keyed properties attached, keyed by the CANONICAL
   *  slug (no version suffix) so lookups do not depend on how the file happened to be named.
   */
  function publishLoadedPlugins() {
    var arr = loadedPlugins
      .filter(function (r) { return r.state === 'loaded'; })
      .map(function (r) { return r.ctx; });
    loadedPlugins.forEach(function (r) {
      if (r.state !== 'loaded') return;
      var slug = r.ctx.manifest && r.ctx.manifest.slug;
      if (!slug) return;
      arr[slug] = r.ctx;
      // Also expose the raw manifest slug in case it differs from the canonical one.
      if (r.slug && r.slug !== slug) arr[r.slug] = r.ctx;
    });
    window.loadedPlugins = arr;
    return arr;
  }

  function fireAllPluginsLoaded() {
    var arr = publishLoadedPlugins();
    loadedPlugins.forEach(function (r) {
      if (r.state !== 'loaded') return;
      dispatchPluginEvent(r.ctx, 'allpluginsloaded', arr);
    });
  }

  /**
   * Publish the loader's plugin states.
   *
   * Called after EVERY plugin finishes, not only at the end of the pass: with one serial chain the
   * final assignment was the only observable moment, so a load that stalled on plugin #7 looked
   * identical to a load that had not started.  The manager can now show progress, and a stalled
   * plugin is visible as the one still in `loading` instead of as a frozen progress bar.
   */
  function publishPluginStates() {
    if (!window.__BNCM_LOADED__) return;
    // Updated in place: this runs once per plugin, and re-allocating the whole snapshot every time
    // made the reporting cost quadratic in the plugin count.
    var arr = window.__BNCM_LOADED__.plugins;
    if (!Array.isArray(arr)) arr = window.__BNCM_LOADED__.plugins = [];
    for (var i = 0; i < loadedPlugins.length; i++) {
      var p = loadedPlugins[i];
      var prev = arr[i];
      if (prev && prev.slug === p.slug && prev.state === p.state) continue;
      arr[i] = { slug: p.slug, version: p.version, state: p.state, error: p.error,
                 core: p.core, disabled: p.disabled, dev: p.dev === true,
                 ncm_version_unverified: !!p.ncm_version_unverified,
                 ncm3_compatible: p.ncm3_compatible, hooks: p.hooks,
                 slow: !!(p.perf && p.perf.slow), load_ms: p.perf ? Math.round(p.perf.load_ms) : null };
    }
    arr.length = loadedPlugins.length;
  }

  /** Register the plugin with NetEase's own extension UI when it exposes the hooks. */
  function registerWithNcmUi(result) {
    try {
      var dbg = window.dbg && window.dbg.Command;
      if (!dbg || typeof dbg.addCall !== 'function') return false;
      dbg.addCall('app.onBootFinish', function () { /* plugin may subscribe too */ });
      return true;
    } catch (e) { return false; }
  }

  /** Mount the plugin manager UI.
   *
   *  It lives in its own file (loader/manager.js) rather than in this framework because the UI
   *  is the part most likely to need changes as the client's DOM drifts -- and because a broken
   *  manager must not be able to stop plugins from loading.  Kept out of the load chain's
   *  failure path for the same reason. */
  var managerInstalled = false;
  function installManager() {
    if (managerInstalled) return Promise.resolve(true);
    if (!API) return Promise.resolve(false);
    return fetch(API + '/manager.js')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (code) {
        try { (new Function(code + '\n//# sourceURL=bncm-manager.js'))(); }
        catch (e) { throw new Error('manager eval failed: ' + (e && e.message)); }
        var mgr = window.__BNCM_MANAGER__;
        if (!mgr || typeof mgr.install !== 'function') throw new Error('manager did not export install()');
        mgr.install(betterncm, {
          loadedPlugins: loadedPlugins,
          reload: loadAllPlugins,
        });
        managerInstalled = true;
        log('plugin manager mounted');
        return true;
      })
      .catch(function (e) {
        warn('plugin manager unavailable: ' + (e && e.message));
        return false;
      });
  }

  /* --------------------------------------------------------------- boot */

  var betterncm = window.betterncm || {};
  betterncm.version = '3.0.0-wip';
  betterncm.build = BUILD;
  betterncm.ncm = ncm;
  betterncm.fs = fs;
  betterncm.path = path;
  betterncm.app = app;
  betterncm.utils = utils;
  betterncm.plugin = plugin;
  betterncm.backend = API;
  // Upstream exports betterncmFetch, which plugins use for endpoints not wrapped here.
  // Paths are relative to BETTERNCM_API_PATH (e.g. betterncmFetch('/app/version')).
  betterncm.betterncmFetch = function (path, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    if (!opts.ignoreApiKey) headers['X-BNCM-Key'] = KEY;
    return fetch(API + '/api' + path, Object.assign({}, opts, { headers: headers }));
  };
  window.betterncmFetch = betterncm.betterncmFetch;
  window.betterncm = betterncm;
  window.__BNCM_FRAMEWORK__ = BUILD;

  // Upstream injects these as globals before the framework; real plugins read them directly
  // (BETTERNCM_FILES_PATH is used by 3 of the 22 plugins in C:\betterncm\plugins).
  if (API) {
    var apiPort = (function () { try { return Number(new URL(API).port); } catch (e) { return 0; } })();
    window.BETTERNCM_API_KEY = KEY;
    window.BETTERNCM_API_PORT = apiPort;
    window.BETTERNCM_API_PATH = API + '/api';
    window.BETTERNCM_FILES_PATH = API + '/local';
  }

  // Upstream sets window.dom from utils.dom (see js-framework src/betterncm-api/index.ts).
  window.dom = utils.dom;

  /* ------------------------------------------------------ selector registry -- */
  /**
   * The client's frontend pack (web.pack) updates independently of the client build, and its
   * class names are CSS-modules hashes that change between packs.  Everything that has to
   * find UI in the page therefore resolves through this registry instead of hard-coding
   * selectors, so a pack update is a DATA fix (loader/selectors.json) and not a code fix.
   *
   * Precedence: host registry entry for this client build > `default` entry > built-in
   * fallback below.  A miss is reported to the host (see reportMissing) rather than being
   * swallowed, which is what makes the next fix possible at all.
   */
  var SELECTOR_FALLBACK = {
    // Verified present in web.pack 477f8a2 (app+subApp chunks) unless marked otherwise.
    mainPageContainer: '.RightContainer_r8p6pvv, [class^=RightContainer_], .right-container',
    appScroll: '[class^=AppScrollContainer_]',
    sidebar: '[class^=LeftScrollContainer_]',
    miniBar: '[class^=MiniModeIconBar_]',
    playerBar: '#main-player, .m-player, .m-player-fm',
    playButton: '#main-player .btnp, .m-player .btnp, .m-player-fm .btnp',
    nowPlaying: '.g-single, [class^=DefaultPlayerContainer_]',
    cover: '.n-single .cdimg img, [class^=VinylCoverContainer_] img',
    lyricRoot: '[class^=LyricWrapper_], [class*=ScrollableLyricDisplayContainer], [class*=LyricDefaultPageContainer]',
    lyricLine: '[class*=LyricDisplayInnerContainer] [class*=line], [class*=lyric]',
    // NOT present in 3.1.41 (kept only so a miss is visible): .cmd-icon-setting, section.g-mn,
    // [class^=CommentWrapper_], .u-cover
    settingsButton: '.cmd-icon-setting, a[href="#/m/setting/"], .m-top .cmd-icon',
  };

  betterncm.dom = betterncm.dom || {};
  var selectors = Object.assign({}, SELECTOR_FALLBACK);
  betterncm.dom.selectors = selectors;
  betterncm.dom.selector = function (key) {
    var v = selectors[key];
    if (!v) { betterncm.dom.reportMissing(key); return null; }
    return v;
  };
  betterncm.dom.el = function (key) {
    var s = betterncm.dom.selector(key);
    if (!s) return null;
    try { return document.querySelector(s); } catch (e) { return null; }
  };

  /** Record a selector miss with a snapshot of plausible candidates.
   *
   *  Deliberately cheap and bounded: this runs at most once per key per session, and the host
   *  appends it to <data>/selector-discovery.json so the registry can be extended offline. */
  var reportedMissing = {};
  betterncm.dom.reportMissing = function (key) {
    if (reportedMissing[key]) return;
    reportedMissing[key] = true;
    var candidates = [];
    try {
      var nodes = document.querySelectorAll('[class]');
      var seen = {};
      for (var i = 0; i < nodes.length && candidates.length < 40; i++) {
        var cls = String(nodes[i].className || '');
        if (!cls || seen[cls]) continue;
        seen[cls] = 1;
        if (/setting|Setting|icon|Icon|toolbar|Toolbar|player|Player|lyric|Lyric|scroll|Scroll/.test(cls)) {
          candidates.push({ tag: nodes[i].tagName, cls: cls.slice(0, 120) });
        }
      }
    } catch (e) { /* ignore */ }
    var report = { key: key, href: location.href, appver: ncm.version, at: new Date().toISOString(),
                   candidates: candidates };
    window.__BNCM_SELECTOR_MISSING__ = (window.__BNCM_SELECTOR_MISSING__ || []).concat([report]);
    warn('selector registry: "' + key + '" has no working value (reported)');
    if (API) {
      try {
        fetch(API + '/api/selector-report', { method: 'POST', headers: hdr(), body: JSON.stringify(report) });
      } catch (e) { /* ignore */ }
    }
  };

  function loadSelectorRegistry() {
    if (!API) return Promise.resolve(selectors);
    return fetch(API + '/api/selectors', { headers: hdr() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (reg) {
        if (!reg || !reg.builds) return selectors;
        var builds = reg.builds;
        var keys = Object.keys(builds);
        var appver = String(ncm.version || '');
        var chosen = null;
        // exact build match first, then a prefix match ("3.1.41" for "3.1.41.205529").
        if (builds[appver]) chosen = builds[appver];
        else {
          for (var i = 0; i < keys.length; i++) {
            if (keys[i] !== 'default' && appver.indexOf(keys[i]) === 0) { chosen = builds[keys[i]]; break; }
          }
        }
        var merged = Object.assign({}, SELECTOR_FALLBACK, builds['default'] || {}, chosen || {});
        selectors = merged;
        betterncm.dom.selectors = merged;
        if (betterncm.injector) betterncm.injector.selectors = { registry: reg.version || null, matched: chosen ? true : false };
        log('selector registry loaded (' + (chosen ? 'build-specific' : 'default/fallback') + ')');
        return merged;
      })
      .catch(function (e) {
        warn('selector registry unavailable: ' + (e && e.message) + ' (using built-in fallbacks)');
        return selectors;
      });
  }

  // `betterncm_native` is provided by the C++ side upstream; plugins use it for fs access.
  // We back it with the same HTTP fs so those call sites keep working, and stub the app
  // methods that need in-process control.
  window.betterncm_native = window.betterncm_native || {
    fs: fs,
    app: {
      // Both exist upstream and both are called by RefinedNowPlaying on its settings page.
      // reloadIgnoreCache: drop caches and re-read the client; from the page that means
      // reloading the document, which is the same observable outcome.
      reloadIgnoreCache: function () {
        return app.reloadPlugins().then(function () { location.reload(); return true; },
          function () { location.reload(); return true; });
      },
      reload: function () { location.reload(); return Promise.resolve(true); },
      restart: function () {
        return ncm.call('app.restart').then(function (r) {
          if (r === undefined) warn('app.restart: the client bridge did not answer; restart manually');
          return r;
        }, function () { return false; });
      },
    },
  };
  window.loadedPlugins = window.loadedPlugins || [];

  window.__BNCM_LOADED__ = {
    build: BUILD,
    at: Date.now(),
    appver: ncm.version,
    channelFunctions: ncm.channelFunctions,
    dbgCommand: !!(window.dbg && window.dbg.Command),
    backend: API,
    plugins: [],
    core: [],
  };

  /** Injection diagnostics, rendered by the plugin manager's diagnostics tab.
   *
   *  Everything here is something we have been wrong about at least once, so it is reported
   *  rather than assumed: whether the document-start preload ran, whether the webpack runtime
   *  was actually hooked, whether the three globals the ported plugins need are really there,
   *  and which hijacks landed. */
  var webpackHooked = !!(window.__BNCM_HIJACK__ && window.__BNCM_HIJACK__.hooksInstalled);
  betterncm.injector = {
    preload: window.__BNCM_PRELOAD__ || null,
    framework: BUILD,
    hijack: window.__BNCM_HIJACK__ || null,
    webpack: (window.__BNCM_WP__ && window.__BNCM_WP__.require) ? 'captured'
             : (webpackHooked ? 'hooked, require pending' : 'not hooked (preload missing?)'),
    react: typeof window.React,
    reactDom: typeof window.ReactDOM,
    legacyNativeCmder: !!(window.legacyNativeCmder &&
                          typeof window.legacyNativeCmder.appendRegisterCall === 'function'),
    selectors: { registry: null, matched: false },
  };
  if (!webpackHooked) {
    warn('document-start preload did not hook webpack; module-level hijacks and ' +
         'ncm.findApiFunction() will not work in this page');
  }
  if (typeof window.React !== 'object' && typeof window.React !== 'function') {
    warn('window.React is missing; React-based plugins (RefinedNowPlaying, LyricBar) cannot render');
  }

  /* Install the lyric feed as early as we can.  window.channel is normally already there, but a
   * plugin-driven reload can race it, so retry briefly rather than silently missing the feed. */
  if (!installLyricsFeed()) {
    var lfTries = 0;
    var lfTimer = setInterval(function () {
      lfTries++;
      if (installLyricsFeed() || lfTries > 40) clearInterval(lfTimer);
    }, 250);
  }
  betterncm.injector.lyricsFeed = lyricsFeed;
  betterncm.injector.lyrics = {
    get pipelineProven() { return lyricsPipelineProven; },
    get pipelineLines() { return lyricsPipelineLines; },
    get feedVerified() { return !!lyricsFeed.verified; },
  };
  betterncm.injector.domAliases = installDomAliases();

  /* Status for BetterNCM's OWN UI.
   *
   * This used to be a floating badge pinned to the bottom-right of the client window.  It is now a
   * data API that loader/manager.js renders inside the plugin manager, so nothing overlays the
   * client's own interface -- the status lives where the rest of BetterNCM lives.
   *
   * Keep this object plain and cheap: the manager polls it while its panel is open. */
  /** Is this an ncm3-generation client (the family the 3.x plugin line targets)? */
  function isNcm3Client() {
    if (window.__BNCM_LOADED__ && window.__BNCM_LOADED__.ncm3_compatible) return true;
    var v = ncm.version;
    if (!v) return false;
    var m = /^(\d+)\.(\d+)/.exec(String(v));
    if (!m) return false;
    return (+m[1] > 3) || (+m[1] === 3 && +m[2] >= 1);
  }

  function collectStatus() {
    var plugins = (window.__BNCM_LOADED__ && window.__BNCM_LOADED__.plugins) || [];
    var core = [], user = [], failed = [];
    for (var i = 0; i < plugins.length; i++) {
      var p = plugins[i];
      (p.core ? core : user).push(p);
      if (p.state !== 'loaded') failed.push(p.slug + ' (' + p.state + ')');
    }
    var hij = window.__BNCM_HIJACK__ || {};
    return {
      build: BUILD,
      ncmVersion: ncm.version || null,
      // Aggregated from the per-plugin records.  The top-level flag this used to read is never set
      // anywhere, so the field was permanently false (test/plugin-ordering.test.mjs case C); the
      // per-plugin filtered form below was already correct.
      ncmVersionUnverified: plugins.some(function (p) { return !!p.ncm_version_unverified; }),
      coreLoaded: core.filter(function (p) { return p.state === 'loaded'; }).length,
      coreTotal: core.length,
      userLoaded: user.filter(function (p) { return p.state === 'loaded'; }).length,
      userTotal: user.length,
      failed: failed,
      backend: API || null,
      intercept: hij.intercept === true,
      appliedHijacks: (hij.applied || []).length,
      pageErrors: (hij.pageErrors || []).length,
      lyrics: {
        feedVerified: !!lyricsFeed.verified,
        pipelineProven: lyricsPipelineProven,
        pipelineLines: lyricsPipelineLines,
        currentLines: (window.currentLyrics && window.currentLyrics.lyrics)
          ? window.currentLyrics.lyrics.length : null,
      },
      domAlias: !!(window.__BNCM_DOM_ALIASES__ && window.__BNCM_DOM_ALIASES__.applied),
    };
  }
  betterncm.status = collectStatus;
  betterncm.statusText = function () {
    var s = collectStatus();
    var total = s.coreLoaded + s.userLoaded;
    var text = s.build + ' \u00b7 NCM ' + (s.ncmVersion || '?');
    if (s.coreTotal) text += ' \u00b7 core ' + s.coreLoaded + '/' + s.coreTotal;
    text += ' \u00b7 plugins ' + total + '\u2713' +
      (s.failed.length ? ' ' + s.failed.length + '\u2717' : '');
    return text;
  };

  /**
   * betterncm.loader -- the loader's own health, for plugins authors and for the manager UI.
   *
   * The point is that "adding a plugin made the client stutter" must be answerable with data:
   * per-plugin download wait / evaluation / hook time, which plugins were cut off by a timeout,
   * and which exceeded their budget.  Everything here is read-only for plugins.
   */
  betterncm.loader = {
    get config() {
      return {
        concurrency: LOADER.concurrency, fetchTimeoutMs: LOADER.fetchTimeoutMs,
        yieldBudgetMs: LOADER.yieldBudgetMs, slowHookMs: LOADER.slowHookMs,
        slowLoadMs: LOADER.slowLoadMs,
      };
    },
    configure: function (opts) {
      opts = opts || {};
      if (opts.concurrency !== undefined) LOADER.concurrency = clampNum(opts.concurrency, 1, 32, LOADER.concurrency);
      if (opts.fetchTimeoutMs !== undefined) LOADER.fetchTimeoutMs = clampNum(opts.fetchTimeoutMs, 50, 120000, LOADER.fetchTimeoutMs);
      if (opts.yieldBudgetMs !== undefined) LOADER.yieldBudgetMs = clampNum(opts.yieldBudgetMs, 4, 1000, LOADER.yieldBudgetMs);
      if (opts.slowHookMs !== undefined) LOADER.slowHookMs = clampNum(opts.slowHookMs, 10, 60000, LOADER.slowHookMs);
      if (opts.slowLoadMs !== undefined) LOADER.slowLoadMs = clampNum(opts.slowLoadMs, 100, 600000, LOADER.slowLoadMs);
      loadPerf.concurrency = LOADER.concurrency;
      return betterncm.loader.config;
    },
    stats: function () { return loadPerf; },
    plugins: function () { return loadPerf.per_plugin.slice(); },
    pageErrors: function () { return (window.__BNCM_PAGE_ERRORS__ || []).slice(); },
    reload: function () { return loadAllPlugins(); },
  };

  /* ------------------------------------------------------------ dev mode -- */
  /**
   * betterncm.dev -- the plugin author's handle on the loader.
   *
   * WHY THIS EXISTS
   * ---------------
   * Iterating on a plugin normally means touching three surfaces in two processes: the manifest
   * and code (a packed .plugin in the plugins directory), loader/hijacks.json (page-level module
   * rewrites) and this framework.  Dev mode puts the whole loop behind one object:
   *
   *   betterncm.dev.enabled           is the host in dev mode at all?
   *   betterncm.dev.addSource(spec)   local dir / .plugin / owner/repo[#ref][:subdir]
   *   betterncm.dev.watch(true)       hot-reload the plugin list when a source changes
   *   betterncm.dev.reload()          re-run the plugin loader now (no page reload)
   *   betterncm.dev.plugins(slug)     why did my plugin load, skip or fail?
   *   betterncm.dev.hook.add(rule)    try a page-level hijack without editing the checkout
   *   betterncm.dev.on('reload', fn)  run after every dev reload
   *
   * The host owns the state: this object only mirrors /api/dev/status.  With an older host, or
   * none at all, every call fails soft and `dev.enabled` stays false -- dev tooling must never be
   * able to break a normal session.
   */
  var DEV = {
    known: false, enabled: false, generation: 0, watching: false, intervalMs: 3000,
    timer: null, sources: [], hooks: [], plugins: [], reloads: 0,
    lastChangeAt: null, lastChange: null, lastReloadAt: null, error: null,
  };
  var devTarget = new EventTarget();

  function devApplyStatus(s) {
    DEV.known = true;
    DEV.enabled = s.enabled === true;
    DEV.sources = s.sources || [];
    DEV.hooks = s.hooks || [];
    DEV.plugins = s.plugins || [];
    DEV.watching = s.watching === true;
    if (s.interval_ms) DEV.intervalMs = s.interval_ms;
    return DEV.enabled;
  }

  function devReloadNow(reason) {
    DEV.reloads++;
    DEV.lastReloadAt = new Date().toISOString();
    log('dev: reloading plugins (' + reason + ')');
    return app.reloadPlugins().then(function () {
      devTarget.dispatchEvent(new CustomEvent('reload', {
        detail: { reason: reason, generation: DEV.generation, reloads: DEV.reloads },
      }));
      return { reloads: DEV.reloads, generation: DEV.generation };
    }, function (e) {
      warn('dev reload failed: ' + (e && e.message));
      return { reloads: DEV.reloads, generation: DEV.generation, error: String(e && e.message) };
    });
  }

  /** Fetch /api/dev/status; reload the plugin list when the host's generation moved forward.
   *
   *  The FIRST status of a session only adopts the generation: a host that has been up for a
   *  while must not make a freshly injected page reload plugins it has not loaded yet. */
  function devRefresh() {
    if (!API) return Promise.resolve(null);
    return api('/api/dev/status').then(function (s) {
      var first = !DEV.known;
      var before = DEV.generation;
      devApplyStatus(s);
      DEV.generation = Number(s.generation || 0) || 0;
      DEV.lastChangeAt = s.last_change_at || null;
      DEV.lastChange = s.last_change || null;
      DEV.error = null;
      if (!first && DEV.generation > before) {
        var why = (s.last_change && s.last_change.why) || 'watch';
        return devReloadNow('generation ' + DEV.generation + ', ' + why)
          .then(function () { return { changed: true, generation: DEV.generation }; });
      }
      return { changed: false, generation: DEV.generation };
    }, function (e) {
      DEV.error = (e && e.message) || 'dev status unavailable';
      return null;
    });
  }

  function devStartPolling(ms) {
    devStopPolling();
    DEV.timer = setInterval(function () { devRefresh(); }, ms || DEV.intervalMs);
  }
  function devStopPolling() {
    if (DEV.timer) { clearInterval(DEV.timer); DEV.timer = null; }
  }

  /** Describe loaded plugins from the loader's own records -- the same source the manager UI
   *  reads, so "why is my plugin not working" has one answer in one place. */
  function devDescribe(slug) {
    var out = [];
    for (var i = 0; i < loadedPlugins.length; i++) {
      var r = loadedPlugins[i];
      if (slug && r.slug !== slug) continue;
      out.push({
        slug: r.slug, name: r.name, version: r.version, author: r.author,
        state: r.state, error: r.error, core: r.core, dev: r.dev === true,
        dev_source: r.dev_source || null, disabled: r.disabled, hooks: r.hooks,
        ncm_version_unverified: !!r.ncm_version_unverified,
        devMode: !!(r.ctx && r.ctx.devMode),
        manifest: (r.ctx && r.ctx.manifest) || null,
      });
    }
    return slug ? (out[0] || null) : out;
  }

  betterncm.dev = {
    get known() { return DEV.known; },
    get enabled() { return DEV.enabled; },
    get generation() { return DEV.generation; },
    get watching() { return DEV.watching; },
    get intervalMs() { return DEV.intervalMs; },
    get sources() { return DEV.sources.slice(); },
    get hooks() { return DEV.hooks.slice(); },
    get reloads() { return DEV.reloads; },
    get lastChange() { return DEV.lastChange; },
    get lastChangeAt() { return DEV.lastChangeAt; },
    get lastReloadAt() { return DEV.lastReloadAt; },
    get error() { return DEV.error; },

    /** One status round trip.  Resolves to {changed, generation} or null when unsupported. */
    refresh: devRefresh,

    /** Re-run the plugin loader in place.  `{hard:true}` reloads the whole document instead,
     *  which is the only way to drop a plugin's leftover DOM/styles -- an in-place reload
     *  re-evaluates scripts but cannot undo what the old copy already did to the page. */
    reload: function (opts) {
      opts = opts || {};
      if (opts.hard) { location.reload(); return Promise.resolve({ reloaded: true }); }
      return devReloadNow(opts.reason || 'requested');
    },

    /** Host-side change detection.  The host watches local directories by mtime and re-fetches
     *  remote sources on a slow interval; this page only polls the generation counter. */
    watch: function (on, intervalMs) {
      var body = { enabled: on !== false };
      if (intervalMs) body.interval_ms = intervalMs;
      return api('/api/dev/watch', body).then(function (r) {
        DEV.watching = r.watching === true;
        if (r.interval_ms) DEV.intervalMs = r.interval_ms;
        if (DEV.watching) devStartPolling(DEV.intervalMs); else devStopPolling();
        return r;
      });
    },

    /** Add a plugin source: a directory, a .plugin/.zip path or URL, or "owner/repo[#ref][:subdir]". */
    addSource: function (spec) {
      return api('/api/dev/sources/add', { source: spec }).then(function (r) {
        return devRefresh().then(function () { return r; });
      });
    },
    removeSource: function (idOrSource) {
      return api('/api/dev/sources/remove', { id: idOrSource }).then(function (r) {
        return devRefresh().then(function () { return r; });
      });
    },

    /** Ad-hoc page-level rewrites.  These are served through the SAME preload path as the
     *  built-in and manifest rules, which is why a change needs a document reload: the preload
     *  fetches the rule list at document-start and cannot see a rule added afterwards. */
    hook: {
      list: function () { return DEV.hooks.slice(); },
      add: function (rule) {
        return api('/api/dev/hooks/add', { rule: rule || {} }).then(function (r) {
          DEV.hooks = r.hooks || DEV.hooks;
          return r;
        });
      },
      clear: function () {
        return api('/api/dev/hooks/clear', {}).then(function (r) { DEV.hooks = []; return r; });
      },
      /** What the preload actually did with those rules in THIS page. */
      applied: function () {
        var h = window.__BNCM_HIJACK__ || {};
        return {
          preload: window.__BNCM_PRELOAD__ || null,
          rulesReady: !!h.rulesReady,
          hooksInstalled: !!h.hooksInstalled,
          applied: h.applied || [],
          missed: h.missed || [],
        };
      },
    },

    /** Loaded-plugin records: devDescribe() for all, or devDescribe(slug) for one. */
    plugins: devDescribe,

    log: function () {
      var args = Array.prototype.slice.call(arguments);
      log('dev: ' + args.map(function (a) {
        return typeof a === 'string' ? a : (function () { try { return JSON.stringify(a); } catch (e) { return String(a); } })();
      }).join(' '));
      return true;
    },

    /** Assertion helper for dev scripts: logs PASS/FAIL and returns the verdict.
     *  Runtime throw-away checks should not have to install a test framework. */
    assert: function (name, cond) {
      var okv = !!cond;
      log('dev assert ' + (okv ? 'PASS' : 'FAIL') + ': ' + name);
      devTarget.dispatchEvent(new CustomEvent('assert', { detail: { name: name, ok: okv } }));
      return okv;
    },

    /** Register a dev event listener; returns an unsubscribe function. */
    on: function (type, fn) {
      var handler = function (evt) { try { fn(evt.detail, evt); } catch (e) { warn('dev.' + type + ' listener threw: ' + (e && e.message)); } };
      devTarget.addEventListener(type, handler);
      return function () { devTarget.removeEventListener(type, handler); };
    },

    /** Cheapest DOM probe a plugin author needs: how many nodes match, and their classes. */
    inspect: function (selector) {
      try {
        var nodes = document.querySelectorAll(selector);
        var classes = [];
        for (var i = 0; i < nodes.length && i < 5; i++) {
          classes.push(nodes[i].tagName + '.' + String(nodes[i].className || '').slice(0, 80));
        }
        return { selector: selector, count: nodes.length, sample: classes };
      } catch (e) { return { selector: selector, count: 0, sample: [], error: String(e && e.message) }; }
    },
  };

  // Adopt the host's dev state (if any) without blocking boot; a plugin's devMode is correct from
  // the first plugin load because it is a getter over the loader's record, not a copied value.
  devRefresh().then(function () {
    if (DEV.enabled) {
      log('dev mode on: ' + DEV.sources.length + ' source(s), ' + DEV.hooks.length + ' ad-hoc hook(s)' +
          (DEV.watching ? ', watching' : ''));
      if (DEV.watching) devStartPolling(DEV.intervalMs);
    }
  });

  log(BUILD + ' injected into ' + location.href + ' (ncm ' + ncm.version + ', ' + ncm.channelFunctions.length + ' bridge fns)');

  if (!API) {
    warn('no backend: set window.__BNCM_CONFIG__ before injecting to load plugins');
    window.__BNCM_LOADED__.plugins = [];
    return 'framework-no-backend:' + BUILD;
  }

  /**
   * Discover and load every plugin, then run the second lifecycle pass.
   *
   * Order is deliberate and not alphabetical: CORE plugins load first, so that a core plugin's
   * `load`/`allpluginsloaded` callbacks run before any user plugin that may probe it through
   * `loadedPlugins` (RefinedNowPlaying's settings page reads
   * loadedPlugins.RefinedNowPlaying.manifest.version, LyricBar probes MaterialYouTheme).
   * Their manifests' `requirements` / `loadAfter` are honoured as an ordering hint between the
   * core plugins themselves.
   *
   * Named so that betterncm.app.reloadPlugins() can re-run it after the user installs a plugin.
   */
  /** Order plugins so that `loadAfter` / `requirements` are loaded before their dependents.
   *
   *  This used to be applied to CORE plugins only, which was fine while the three big plugins
   *  shipped as built-ins.  They are now ordinary user plugins (fully disable-able / removable,
   *  like every other plugin), so the ordering has to apply to user plugins too -- otherwise
   *  RefinedNowPlayingNext's `loadAfter: ["MaterialYouTheme", ...]` is silently ignored and it can
   *  load before the theme it expects to build on. */
  function orderPlugins(list) {
    var bySlug = {};
    list.forEach(function (p) { if (p.manifest) bySlug[p.manifest.slug] = p; });
    var out = [];
    var seen = {};
    function visit(p, depth) {
      if (!p || !p.manifest || seen[p.manifest.slug] || depth > 8) return;
      seen[p.manifest.slug] = true;
      var after = [].concat(p.manifest.loadAfter || [], p.manifest.requirements || []);
      after.forEach(function (slug) { if (bySlug[slug]) visit(bySlug[slug], depth + 1); });
      out.push(p);
    }
    list.forEach(function (p) { visit(p, 0); });
    return out;
  }

  function assertPluginGlobals() {
    var missing = [];
    if (!window.React) missing.push('React');
    if (!window.ReactDOM) missing.push('ReactDOM');
    if (!window.legacyNativeCmder ||
        typeof window.legacyNativeCmder.appendRegisterCall !== 'function') missing.push('legacyNativeCmder');
    if (missing.length) {
      warn('client globals missing before plugin load: ' + missing.join(', ') +
           ' -- plugins that need them will fail');
    }
    return missing;
  }

  var pluginLoadStarted = false;
  var pluginLoadPromise = null;
  var pluginReloadScheduled = false;
  function loadAllPlugins() {
    // Most third-party plugins have no teardown hook. Re-evaluating them leaves observers,
    // timers, React roots and styles alive. Use a fresh document for subsequent reloads.
    if (pluginLoadStarted) {
      if (!pluginLoadPromise) return Promise.resolve([]);
      return pluginLoadPromise.then(function () {
        if (!pluginReloadScheduled) {
          pluginReloadScheduled = true;
          location.reload();
        }
        return loadedPlugins;
      });
    }
    pluginLoadStarted = true;
    loadedPlugins.length = 0;
    loadPerf.started_at = nowMs();
    loadPerf.finished_at = null;
    loadPerf.total_ms = null;
    loadPerf.complete = false;
    loadPerf.per_plugin.length = 0;
    loadPerf.timeouts.length = 0;
    loadPerf.slow.length = 0;
    loadPerf.failures.length = 0;
    loadPerf.page_errors.length = 0;
    loadPerf.eval_ms = 0;
    loadPerf.hook_ms = 0;
    loadPerf.yields = 0;
    loadPerf.fetched_bytes = 0;
    loadPerf.failed_fetches = 0;
    window.__BNCM_LOADED__.perf = loadPerf;
    initPageErrorCapture();
    // Wait for the React shim first: plugins are evaluated synchronously once fetched, and a
    // React bundle referencing the bare global `h` fails immediately if it is not set yet.
    pluginLoadPromise = reactReady.then(function () {
      return loadSelectorRegistry();
    }).then(function () {
      return api('/api/plugins');
    }).then(function (r) {
      var core = orderPlugins((r.core || []).filter(function (p) { return p.manifest; }));
      var user = orderPlugins((r.plugins || []).filter(function (p) { return p.manifest; }));
      var disabled = user.filter(function (p) { return p.disabled; }).map(function (p) { return p.manifest.slug; });
      log('discovered ' + core.length + ' core + ' + user.length + ' user plugin(s)' +
          (disabled.length ? ' (' + disabled.length + ' disabled: ' + disabled.join(', ') + ')' : ''));
      assertPluginGlobals();
      window.__BNCM_LOADED__.core = core.map(function (p) { return p.manifest.slug; });
      // Start the synchronous getPlaying cache before plugins run: RefinedNowPlaying reads
      // ncm.getPlaying().id as soon as its lyrics pipeline first executes.
      refreshPlayingCache();

      /* ---- plan: which scripts will be needed, in evaluation order -------- */
      var plan = [];
      var skippedScripts = 0;
      function add(item, isCore) {
        var m = item.manifest;
        var files = [];
        var bucket = m.injects && (m.injects.Main || m.injects['/pub/app.html']);
        if (Array.isArray(bucket)) {
          bucket.forEach(function (it) { if (it && it.file) files.push(it.file.replace(/^\.\//, '')); });
        }
        // A plugin the gates will skip is never evaluated, so downloading its scripts would be
        // pure waste -- and with a disabled-plugin list that is most of the set.  The gate is the
        // same function loadPlugin uses, so this can only ever avoid work, never change a verdict.
        var gate = pluginGate(item, isCore);
        var willLoad = !(gate && gate.reason);
        if (!willLoad) skippedScripts += files.length;
        plan.push({ plugin: item, isCore: isCore, files: files, willLoad: willLoad, base: 0 });
      }
      core.forEach(function (p) { add(p, true); });
      user.forEach(function (p) { add(p, false); });

      var sources = [];
      plan.forEach(function (item) {
        item.base = sources.length;
        if (!item.willLoad) return;
        item.files.forEach(function (f) { sources.push({ slug: item.plugin.manifest.slug, file: f }); });
      });
      loadPerf.plugins = core.length + user.length;
      loadPerf.skipped_scripts = skippedScripts;
      loadPerf.planned_scripts = sources.length;

      /* ---- downloads: all of them, at once, bounded ---------------------- */
      var pool = startPrefetch(sources, LOADER.concurrency);

      /* ---- evaluation: strictly in order, with the main thread handed back */
      var lastYield = nowMs();
      function yieldIfNeeded() {
        var t = nowMs();
        if (t - lastYield < LOADER.yieldBudgetMs) return null;
        lastYield = t;
        loadPerf.yields++;
        return yieldNow().then(function () { lastYield = nowMs(); });
      }

      var chain = Promise.resolve();
      plan.forEach(function (item) {
        chain = chain.then(function () {
          var mine = item.willLoad
            ? item.files.map(function (f, i) { return pool.promises[item.base + i]; })
            : null;
          return loadPlugin(item.plugin, item.isCore, mine && mine.length ? mine : null);
        }).then(function () {
          var y = yieldIfNeeded();
          return y || undefined;
        });
      });
      return chain;
    }).then(function () {
      fireAllPluginsLoaded();
      var byState = function (state) {
        return loadedPlugins.filter(function (p) { return p.state === state; }).length;
      };
      loadPerf.loaded = byState('loaded');
      loadPerf.error = byState('error');
      loadPerf.skipped = byState('skipped');
      loadPerf.total_ms = nowMs() - loadPerf.started_at;
      loadPerf.finished_at = nowMs();
      publishPluginStates();
      window.__BNCM_LOADED__.perf = loadPerf;
      // The pass is done: nothing is allowed to advance the pool any more.
      loadPerf.complete = true;
      log('plugins: ' + loadPerf.loaded + ' loaded, ' + loadPerf.error + ' error, ' +
          loadPerf.skipped + ' skipped in ' + Math.round(loadPerf.total_ms) + 'ms' +
          ' (fetch ' + Math.round(loadPerf.fetch_phase_ms || 0) + 'ms x' + loadPerf.concurrency +
          ', eval ' + Math.round(loadPerf.eval_ms) + 'ms, hooks ' + Math.round(loadPerf.hook_ms) +
          'ms, ' + loadPerf.yields + ' yield(s)' +
          (loadPerf.skipped_scripts ? ', ' + loadPerf.skipped_scripts + ' script(s) not downloaded' : '') +
          (loadPerf.timeouts.length ? ', ' + loadPerf.timeouts.length + ' timed out' : '') + ')');
      if (loadPerf.slow.length) {
        warn('plugins over budget: ' + loadPerf.slow.map(function (s) {
          return s.slug + '/' + s.phase + '=' + s.ms + 'ms';
        }).join(', '));
      }
      flushLogQueue();
      return installManager().then(function () { return loadedPlugins; });
    }).catch(function (err) {
      warn('plugin discovery failed: ' + err.message);
      loadPerf.total_ms = nowMs() - (loadPerf.started_at || nowMs());
      window.__BNCM_LOADED__.perf = loadPerf;
      return [];
    });
    return pluginLoadPromise;
  }

  loadAllPlugins();

  // Replacement for the old lightweight bootstrap canary.
  return 'framework:' + BUILD;
})();
