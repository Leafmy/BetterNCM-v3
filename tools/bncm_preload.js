/* bncm_preload.js -- document-start bootstrap for the NetEase client page.
 *
 * Registered with CDP `Page.addScriptToEvaluateOnNewDocument`, so it runs BEFORE any of the
 * client's own scripts on every navigation.  That timing is the whole point: the client is a
 * webpack bundle, and the only reliable place to rewrite a module is the moment its factory
 * is registered -- after the app has booted there is nothing left to hook.
 *
 * Two jobs:
 *
 *   1. Install the module-level hijack engine.  Upstream BetterNCM rewrites the RESPONSE BODY
 *      of `orpheus://orpheus/pub/<x>` from inside the client (a CEF scheme handler, which we
 *      cannot build without the CEF headers -- see docs/06-plugin-framework.md section 7).
 *      This does the equivalent from the page: the webpack jsonp runtime is taken over at the
 *      `push` assignment, every incoming module factory's source is matched against the rule
 *      set, hit factories are rewritten with `new Function(...)` and re-registered.  Same
 *      `from`/`to` semantics, no native code.
 *
 *   2. Fetch and evaluate the real framework once the DOM is usable, so the framework itself
 *      does not have to race the page.
 *
 * Failure policy: this file must never break the client.  Every hook is wrapped; if the
 * backend is unreachable or a rule does not match, the page loads exactly as it would have.
 * Rules that DID apply (and rules that were expected but never matched) are recorded in
 * `window.__BNCM_HIJACK__` so the plugin manager can show the truth instead of guessing.
 */
(function () {
  'use strict';

  if (window.__BNCM_PRELOAD__) return;                 // idempotent across re-injection
  var BUILD = 'bncm-v3-preload/0.1.0';
  window.__BNCM_PRELOAD__ = BUILD;

  var CFG = window.__BNCM_CONFIG__ || {};
  var API = CFG.api || null;
  var KEY = CFG.key || '';
  /* Interposing on window.webpackJsonp is ONLY needed when a hijack rule is actually enabled.
   * Measured on the live client: the interposition itself (installing the `push` accessor plus the
   * synthetic capture module) is enough to stop the client from mounting -- `#root` empty, five
   * bare "Script error." events -- even with zero rules and pure passthrough.  So the injector
   * decides: the agent computes `intercept` from loader/hijacks.json (true only when at least one
   * rule is enabled) and passes it here.  With every rule disabled -- the state documented in
   * docs/11 section 8 -- this script is a plain bootstrap that only brings the framework up. */
  var INTERCEPT = CFG.intercept !== false;

  /* How long a chunk may wait for the rule set before we give up and let it through.
   * Buffering is what makes a hijack actually land (a rule that arrives after its module has
   * executed is useless), but blocking the app on a dead backend would be far worse. */
  var RULES_TIMEOUT_MS = 2000;

  var state = {
    build: BUILD,
    hooksInstalled: false,      // the accessor is in place (NOT proof the runtime assigned push)
    runtimeHooked: false,       // the webpack runtime actually did `t.push = c`  <-- the real signal
    jsonpPayloads: 0,
    modulesSeen: 0,
    modulesRewritten: 0,
    rulesLoaded: 0,
    rulesReady: false,
    rulesLate: false,
    bufferedPayloads: 0,
    applied: [],          // { id, slug, moduleId, kind, replacements }
    wrapped: [],          // { id, moduleId, key } -- functions replaced by a wrap-export rule
    skipped: [],          // { id, moduleId, reason } -- matched but deliberately not rewritten
    expected: [],         // every rule we were told about
    missed: [],           // rules that were loaded but never matched anything
    errors: [],
    // Uncaught page errors.  This is the tripwire for the failure mode we hit live: a rewritten
    // webpack factory loses its closure, throws at run time, and the app never mounts.  Without
    // this the symptom is just "blank window".
    pageErrors: [],
    webpack: {
      captured: false,
      moduleCount: 0,
    },
  };
  /** Module id currently being wrapped, for the `wrapped` record. */
  var currentModuleId = null;
  window.__BNCM_HIJACK__ = state;

  /* Tripwire: capture uncaught page errors and unhandled rejections.
   *
   * A module rewritten through `new Function` loses its original closure, so a module that used to
   * resolve a free identifier now throws -- and one throwing module is enough to abort the client's
   * boot, which presents as a blank window with no other clue.  Recording the first few errors
   * (with the file/line) turns that into a diagnosis. */
  try {
    window.addEventListener('error', function (ev) {
      pushCapped(state.pageErrors, {
        kind: 'error',
        message: String((ev && (ev.message || (ev.error && ev.error.message))) || '?'),
        source: ev && ev.filename ? String(ev.filename).split('/').pop() : null,
        line: ev && ev.lineno,
        at: Date.now(),
      });
    }, true);
    window.addEventListener('unhandledrejection', function (ev) {
      pushCapped(state.pageErrors, {
        kind: 'rejection',
        message: String((ev && ev.reason && (ev.reason.message || ev.reason)) || '?'),
        at: Date.now(),
      });
    });
  } catch (e) { /* ignore */ }

  /* Boot forensics.  The engine can only rewrite a module factory if it is interposed BEFORE the
   * webpack runtime assigns `push`, so "did we actually run first?" is the single most useful
   * thing to record.  If `hadJsonp` is true here, the preload lost the race and the chunks that
   * already went through the plain array can never be rewritten (they are reported as buffered
   * forever, which is exactly the failure mode we hit on the first live run). */
  state.boot = {
    readyState: (typeof document !== 'undefined' && document.readyState) || 'unknown',
    hadJsonp: Object.prototype.hasOwnProperty.call(window, 'webpackJsonp'),
    existingPushType: (window.webpackJsonp && typeof window.webpackJsonp.push) || null,
    existingLength: (window.webpackJsonp && window.webpackJsonp.length) || 0,
    hadFramework: !!(window.__BNCM_LOADED__ && window.__BNCM_LOADED__.build),
    at: Date.now(),
  };

  function note(msg) {
    try { console.log('[BetterNCM/preload] ' + msg); } catch (e) { /* ignore */ }
  }
  function fail(msg) {
    state.errors.push(msg);
    note('ERROR ' + msg);
  }
  function own(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  /* ------------------------------------------------------------- rules ---- */

  var rules = [];
  var rulesReady = false;

  function loadRules() {
    if (!API) { rulesReady = true; state.rulesLate = true; flush('no backend'); return; }
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      rulesReady = true;
      state.rulesLate = true;
      state.rulesReady = true;
      // The rules never arrived: treat it like "nothing actionable" and become transparent,
      // releasing anything we held back (a dead backend must not stall the client's boot).
      passthrough = true;
      state.passthrough = true;
      var heldOnTimeout = buffered;
      buffered = [];
      state.bufferedPayloads = 0;
      for (var t2 = 0; t2 < heldOnTimeout.length; t2++) dispatch(heldOnTimeout[t2], true);
      note('rules timeout: engine is a pure passthrough');
    }, RULES_TIMEOUT_MS);

    fetch(API + '/api/hijacks', { headers: { 'X-BNCM-Key': KEY } })
      .then(function (r) { return r.ok ? r.json() : { rules: [] }; })
      .then(function (j) {
        rules = (j && j.rules ? j.rules : []).filter(function (r) { return r && !r.pending; });
      })
      .catch(function (e) { fail('rules fetch failed: ' + (e && e.message)); rules = []; })
      .then(function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rulesReady = true;
        state.rulesReady = true;
        state.rulesLoaded = rules.length;
        state.actionable = actionableCount();
        state.expected = rules.map(function (r) { return r.id; });
        note('hijack rules: ' + rules.length + ' (' + state.actionable + ' actionable)');
        if (state.actionable === 0) {
          // Nothing to apply: become a transparent passthrough and release anything held.
          passthrough = true;
          state.passthrough = true;
          var held = buffered;
          buffered = [];
          state.bufferedPayloads = 0;
          for (var h = 0; h < held.length; h++) dispatch(held[h], true);
          note('no actionable hijack rules; engine is a pure passthrough');
        } else {
          flush('rules ready');
        }
        selfHealIfTooLate();
      });
  }

  /** If this script ran AFTER the bundle, the chunks in front of us can never be rewritten.
   *
   *  Measured on the live client: the preload logged `readyState: "interactive", hadJsonp: true,
   *  existingLength: 39` -- i.e. it was injected once the page had already parsed and executed its
   *  inline runtime plus every chunk script.  Nothing can fix the current document, but a single
   *  reload puts this same (already registered) script ahead of the bundle, because
   *  Page.addScriptToEvaluateOnNewDocument applies to every NEW document.
   *
   *  Guarded by sessionStorage so a client that somehow never gives us document-start cannot
   *  reload-loop.  `state.selfReloaded` makes the behaviour visible in the diagnostics tab
   *  instead of looking like a mysterious refresh. */
  function selfHealIfTooLate() {
    try {
      var actionable = rules.filter(function (r) {
        return r.type === 'wrap-export' ? (r.locate && r.wrapper) : (r.from && r.to);
      }).length;
      if (!actionable) return;
      if (!state.boot || !state.boot.hadJsonp || state.boot.existingLength <= 0) return;
      if (window.sessionStorage && window.sessionStorage.getItem('__bncm_preload_reloaded__')) return;
      if (window.sessionStorage) window.sessionStorage.setItem('__bncm_preload_reloaded__', String(Date.now()));
      state.selfReloaded = true;
      note('preload ran after the bundle (hadJsonp=' + state.boot.hadJsonp +
           ', payloads=' + state.boot.existingLength + '); reloading once so the rules can run');
      location.reload();
    } catch (e) {
      fail('self-heal reload: ' + (e && e.message));
    }
  }

  /* ---------------------------------------------------- webpack hijacking ---- */

  /* ------------------------------------------------------- built-in wrappers ---- */

  /** Wrappers used by `wrap-export` rules.
   *
   *  Why this rule type exists, next to plain `from`/`to` rewriting
   *  ------------------------------------------------------------------
   *  RefinedNowPlaying only DEFINES window.onProcessLyrics; the sole caller is the client's lyric
   *  pipeline.  Upstream made that caller exist by rewriting the response body of a bundle with a
   *  byte-exact fragment of the minified code.  We can do better than that fragment game: in
   *  3.1.41 the pipeline entry point is an EXPORTED function of a small module
   *      n.d(t,"a",(function(){return a})); ... function a(e){const t={...};if(!e.lrc&&!e.yrc)return t; ...
   *  and the fragment `if(!e.lrc&&!e.yrc)return t;` occurs exactly once per bundle.  So instead of
   *  rebuilding the module from edited source (which needs the minified local names to stay
   *  spelled the same), we let the module run untouched and replace the EXPORT with a wrapper.
   *  The browser's module consumers read that export per call (harmony imports are live
   *  bindings), and we wrap before this module's first caller can see it, because the wrap happens
   *  in the same synchronous step as the module's execution.
   *
   *  This is the least fragile of the three options we considered (source rewrite / runtime poll /
   *  this), and it needs no native CEF scheme handler. */
  var WRAPPERS = {
    'lyrics-hook': function (original) {
      var wrapped = function (payload) {
        try {
          var hook = window.onProcessLyrics;
          if (typeof hook === 'function') {
            // RNP's hook is side-effect driven: it kicks off processing in a setTimeout, publishes
            // window.currentLyrics and dispatches `lyrics-updated`, then returns the payload it was
            // given (via the chain of previous hooks).  So the return value is passed through
            // unchanged; calling it is what matters.
            var out = hook(payload);
            if (out && (out.lrc || out.yrc || out.tlyric || typeof out === 'string')) payload = out;
          }
        } catch (e) {
          try { console.warn('[BetterNCM] onProcessLyrics threw:', e); } catch (e2) { /* ignore */ }
        }
        var args = Array.prototype.slice.call(arguments);
        args[0] = payload;
        return original.apply(this, args);
      };
      wrapped.__bncmWrapped = 'lyrics-hook';
      return wrapped;
    },
  };

  /** Replace matching exported functions on a module's exports object with wrapped versions.
   *
   *  Iterates own property names (harmony exports are getters, so reading them is intentional) and
   *  checks the one-level `default` namespace too, which is where several of this bundle's modules
   *  hang their exports. */
  function wrapModuleExports(exportsObj, rule) {
    var wrapper = rule.wrapper ? WRAPPERS[rule.wrapper] : null;
    if (!wrapper) { fail('unknown wrapper: ' + rule.wrapper); return 0; }

    function consider(target, key) {
      var value;
      try { value = target[key]; } catch (e) { return false; }
      if (typeof value !== 'function') return false;
      if (value.__bncmWrapped) return false;             // already wrapped: stay idempotent
      var src;
      try { src = Function.prototype.toString.call(value); } catch (e) { return false; }
      if (src.indexOf(rule.locate) === -1) return false;
      // Webpack's `n.d` helper defines harmony exports as
      //     Object.defineProperty(exports, key, { enumerable: true, get: fn })
      // with `configurable` left at its default of FALSE, so the binding cannot be replaced from
      // outside.  That is a real, verified limitation of this route (see the note on the
      // builtin:lyrics-hook rule), and it must be reported rather than silently skipped -- a
      // hijack that looks installed and does nothing is the worst possible outcome.
      var desc;
      try { desc = Object.getOwnPropertyDescriptor(target, key); } catch (e) { desc = null; }
      if (desc && desc.configurable === false) {
        fail('cannot wrap non-configurable export "' + key + '" (module ' + currentModuleId +
             '): rule ' + rule.id + ' needs the replace rule type instead');
        return false;
      }
      try {
        Object.defineProperty(target, key, {
          value: wrapper(value), enumerable: true, configurable: true, writable: true,
        });
      } catch (e) {
        fail('could not replace export "' + key + '" (module ' + currentModuleId + '): ' + e.message);
        return false;
      }
      var record = { id: rule.id, slug: rule.slug || null, moduleId: currentModuleId, key: key,
                     kind: 'wrap-export' };
      state.wrapped.push(record);
      state.applied.push(record);
      note('hijack applied: ' + rule.id + ' -> module ' + currentModuleId + ' export "' + key + '"');
      return true;
    }

    var count = 0;
    var keys;
    try { keys = Object.getOwnPropertyNames(exportsObj); } catch (e) { return 0; }
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === '__esModule') continue;
      if (consider(exportsObj, k)) { count++; continue; }
      var nested;
      try { nested = exportsObj[k]; } catch (e) { continue; }
      if (nested && typeof nested === 'object') {
        var nkeys;
        try { nkeys = Object.getOwnPropertyNames(nested); } catch (e) { continue; }
        for (var j = 0; j < nkeys.length; j++) {
          if (consider(nested, nkeys[j])) count++;
        }
      }
    }
    return count;
  }

  /** Turn a factory into one that wraps its exports as soon as the module has run. */
  function makeWrappingFactory(id, factory, rule) {
    var wrappedFactory = function (module, exports, __webpack_require__) {
      currentModuleId = id;
      try {
        return factory.call(this, module, exports, __webpack_require__);
      } finally {
        try { wrapModuleExports(exports, rule); }
        catch (e) { fail('wrap ' + rule.id + ' on module ' + id + ': ' + (e && e.message)); }
        currentModuleId = null;
      }
    };
    wrappedFactory.__bncmWrapping = rule.id;
    return wrappedFactory;
  }

  /** Rewrite one module factory if any rule matches its source.
   *
   *  Two hardening rules came out of the first live run, where `applied` and `errors` grew into
   *  the hundreds within seconds:
   *
   *   1. A factory is processed AT MOST ONCE.  `handlePayload` rewrites the payload's factory slot
   *      in place, so a payload that is pushed again would otherwise re-enter here, re-match, and
   *      (on failure) retry forever.  The marker lives on the function object itself.
   *   2. A module too large to re-parse is reported once and skipped, instead of throwing
   *      "Maximum call stack size exceeded" on every push.  The vendors bundle contains a
   *      multi-megabyte module, and `new Function` cannot recompile it -- upstream never hit this
   *      because it rewrote a response body once rather than re-creating a function.
   */
  var MAX_REWRITE_BYTES = 512 * 1024;

  function applyRulesToFactory(id, factory) {
    if (typeof factory !== 'function') return factory;
    if (factory.__bncmSeen) return factory;          // hardening rule 1
    state.modulesSeen++;

    var source;
    try { source = Function.prototype.toString.call(factory); }
    catch (e) { return factory; }

    var out = source;
    var hits = [];
    var wrapRule = null;

    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];

      // wrap-export: match the module by a source fragment; the actual wrap happens when the
      // module executes, and only THEN is the rule counted as applied.
      if (rule.type === 'wrap-export') {
        if (!rule.locate || !rule.wrapper) continue;
        if (factory.__bncmWrapping) continue;             // already wrapped
        if (source.indexOf(rule.locate) === -1) continue;
        wrapRule = rule;
        note('wrap-export armed: ' + rule.id + ' on module ' + id);
        continue;
      }

      if (!rule.from || !rule.to) continue;
      if (out.indexOf(rule.from) === -1) continue;
      var before = out;
      out = out.split(rule.from).join(rule.to);
      hits.push({
        id: rule.id,
        slug: rule.slug || null,
        moduleId: id,
        kind: 'replace',
        replacements: before.split(rule.from).length - 1,
      });
    }

    if (!hits.length && !wrapRule) return factory;

    // Mark the ORIGINAL as seen in every path, so a failed or non-applicable module is never
    // revisited.  (The rewritten copy is marked after it is built.)
    try { factory.__bncmSeen = true; } catch (e) { /* frozen factory: fall through */ }

    var rebuilt = factory;
    if (out !== source) {
      if (out.length > MAX_REWRITE_BYTES) {
        markSkipped(id, hits, 'module source is ' + out.length + ' bytes (> ' + MAX_REWRITE_BYTES +
                             '); re-parsing it would exceed the parser stack');
        return factory;
      }
      try {
        rebuilt = (new Function('return (' + out + ')'))();
        if (typeof rebuilt !== 'function') throw new Error('rewrite did not produce a function');
      } catch (e) {
        markSkipped(id, hits, 'rewrite failed: ' + (e && e.message));
        return factory;                       // fall back to the untouched factory
      }
    }
    if (wrapRule) rebuilt = makeWrappingFactory(id, rebuilt, wrapRule);
    try { rebuilt.__bncmSeen = true; } catch (e) { /* ignore */ }

    if (hits.length) state.modulesRewritten++;
    for (var h = 0; h < hits.length; h++) {
      pushCapped(state.applied, hits[h]);
      note('hijack applied: ' + hits[h].id + ' -> module ' + id + ' (' + hits[h].kind + ')');
    }
    return rebuilt;
  }

  /** Record a module we deliberately did not rewrite.  Reported once per module, never as a
   *  repeating error, because "this one is too big" is a fact about the bundle, not a fault. */
  function markSkipped(id, hits, reason) {
    for (var i = 0; i < hits.length; i++) {
      state.missed.push(hits[i].id);
      pushCapped(state.skipped, { moduleId: id, id: hits[i].id, reason: reason });
      note('hijack SKIPPED: ' + hits[i].id + ' on module ' + id + ' -- ' + reason);
    }
  }

  /** Keep the diagnostic arrays bounded; the counters stay exact. */
  function pushCapped(arr, item, cap) {
    var limit = cap || 50;
    if (arr.length < limit) arr.push(item);
    else if (arr.length === limit) arr.push('…further entries suppressed');
  }

  /** Inspect (and possibly rewrite) one jsonp payload: [chunkIds, modules, entryIds]. */
  function handlePayload(payload) {
    try {
      var modules = payload && payload[1];
      if (modules && typeof modules === 'object') {
        for (var id in modules) {
          if (!own(modules, id)) continue;
          if (typeof modules[id] === 'function') {
            modules[id] = applyRulesToFactory(id, modules[id]);
          }
        }
      }
    } catch (e) {
      fail('handlePayload: ' + (e && e.message));
    }
    return payload;
  }

  var buffered = [];
  /** When no rule is actionable there is nothing to rewrite, so the engine must stay completely
   *  out of the way: no buffering (which delays chunk registration) and no scanning (which walks
   *  millions of factories).  Getting this wrong is not a performance issue -- holding a chunk
   *  back, or re-entering the runtime while it initialises, is enough to stop the client booting
   *  (measured: the app failed to mount with only "Script error." to show for it). */
  var passthrough = false;
  function actionableCount() {
    var n = 0;
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.type === 'wrap-export' ? (r.locate && r.wrapper) : (r.from && r.to)) n++;
    }
    return n;
  }
  /** The webpack runtime's own push callback, learned from its `t.push = c` assignment.
   *
   *  Deliberately starts as null and is NEVER seeded with Array.prototype.push.  Seeding it
   *  was a real bug: an empty array already has a working push, so "realPush exists" stopped
   *  meaning "the runtime is live", and a payload that arrived before the runtime was written
   *  straight into the array -- where the runtime's own replay loop (`for(...) c(t[o])`) feeds
   *  it to its RAW callback, bypassing the hijack engine with no trace.  `runtimeLive` is the
   *  condition that actually matters. */
  var realPush = null;
  var runtimeLive = false;
  var dispatch;                            // assigned in install()

  function flush(why) {
    if (!buffered.length) return;
    var pending = buffered;
    buffered = [];
    state.bufferedPayloads = 0;
    note('flushing ' + pending.length + ' buffered chunk(s) (' + why + ')');
    for (var i = 0; i < pending.length; i++) dispatch(pending[i]);
    checkMissed();
  }

  /** A rule that loaded but never matched is almost always a frontend-pack drift.  Record it
   *  loudly: the plugin manager surfaces this, and docs/05 says to re-verify per build.
   *
   *  Exposed on the state object as well as being called automatically, because "missed" is
   *  only meaningful once the app has finished loading its chunks -- the manager calls it when
   *  it renders diagnostics, and the test suite calls it deterministically instead of guessing
   *  at a timing. */
  function checkMissed() {
    if (!state.rulesReady) return;
    var settled = {};
    for (var i = 0; i < state.applied.length; i++) settled[state.applied[i].id] = true;
    for (var j = 0; j < state.skipped.length; j++) settled[state.skipped[j].id] = true;
    state.missed = rules
      .filter(function (r) {
        // Must mirror what applyRulesToFactory actually treats as actionable, or a rule that can
        // never fire (e.g. a wrap-export whose fragment is gone) would look healthy.
        var actionable = r.type === 'wrap-export' ? (r.locate && r.wrapper) : (r.from && r.to);
        return !!actionable && !settled[r.id];
      })
      .map(function (r) { return r.id; });
    if (state.missed.length) {
      note('WARNING: ' + state.missed.length + ' hijack rule(s) matched nothing: ' + state.missed.join(', '));
    }
    return state.missed;
  }
  state.checkMissed = checkMissed;

  /** Capture the webpack require so the framework can reach live modules (findApiFunction).
   *
   *  Payload shape matters and is dictated by the runtime we measured in this client build:
   *  a real chunk pushes `[[chunkIds], modules, [[entryModuleIds]]]` (see
   *  app.chunk.477f8a2.js: `push([[31,24,224],[...],[[1424,33,12,37,0,7]]])`).  The third
   *  element is a LIST of entry lists, and the runtime ends up calling
   *  `__webpack_require__(entry[0])` for each -- that is what executes a module.  So a
   *  synthetic payload with the same shape runs our factory and hands it `__webpack_require__`.
   *  `modules` is given as an object (not a sparse array) to avoid materialising a huge
   *  indexed array; the runtime only ever does `for (id in modules)`. */
  function captureWebpack() {
    if (state.webpack.captured) return;
    if (!runtimeLive || !realPush) return;
    var id = 999999999;
    try {
      var modules = {};
      modules[id] = function (module, exports, __webpack_require__) {
        window.__BNCM_WP__ = {
          require: __webpack_require__,
          cache: __webpack_require__.c || null,
          modules: __webpack_require__.m || null,
        };
        state.webpack.captured = true;
        if (__webpack_require__.c) state.webpack.moduleCount = Object.keys(__webpack_require__.c).length;
        note('webpack require captured (' + state.webpack.moduleCount + ' modules cached)');
      };
      // NOTE: bypasses dispatch() on purpose.  Capturing __webpack_require__ has nothing to do
      // with the rule set, and dispatch() would hold it in the rules buffer -- which would mean
      // a slow (or dead) backend also costs us ncm.findApiFunction() and the synchronous
      // getPlaying() path.  The runtime is live at this point, so hand the payload straight to it.
      dispatch([[id], modules, [[id]]], /* bypassBuffer */ true);
    } catch (e) {
      fail('webpack capture failed: ' + (e && e.message));
    }
  }

  function install() {
    if (state.hooksInstalled) return;
    try {
      var arr = window.webpackJsonp;
      if (!arr) arr = window.webpackJsonp = [];

      dispatch = function (payload, bypassBuffer) {
        state.jsonpPayloads++;
        // No actionable rule -> hand the payload straight to the runtime, unmodified and
        // unbuffered.  This is the difference between "the loader is transparent" and "the loader
        // stops the client from booting".
        if (!bypassBuffer && passthrough) {
          return realPush ? realPush.call(arr, payload) : undefined;
        }
        // Two reasons to hold a payload back, and both are correctness reasons:
        //   * the rules are not here yet -- rewriting later is impossible, because a module
        //     factory that has already been registered cannot be reached again;
        //   * the runtime has not installed its push yet -- there is nothing to hand the
        //     payload to, and writing it into the array would let the runtime's replay loop
        //     feed it to its RAW callback, silently bypassing us.
        if (!bypassBuffer && (!rulesReady || !runtimeLive)) {
          buffered.push(payload);
          state.bufferedPayloads = buffered.length;
          return undefined;
        }
        return (realPush || Array.prototype.push).call(arr, handlePayload(payload));
      };

      // The webpack runtime does:   u = t.push.bind(t); t.push = c;
      // An accessor lets us both (a) keep our own wrapper visible to chunk files, and
      // (b) learn the runtime's handler the moment it installs it.
      Object.defineProperty(arr, 'push', {
        configurable: true,
        enumerable: false,
        get: function () { return dispatch; },
        set: function (fn) {
          realPush = fn;
          runtimeLive = true;
          state.runtimeHooked = true;
          state.hooksInstalled = true;
          note('webpack jsonp runtime hooked');
          // DEFERRED ON PURPOSE.  Calling back into the runtime from inside its own
          // `t.push = c` assignment re-enters it while it is still initialising (it has yet to do
          // `t = t.slice()`, replay queued payloads, and run `d()`), which corrupts its boot state:
          // measured as the client never mounting, with 5 x "Script error." and nothing else.
          // A microtask runs after the runtime's script task finishes and before the next chunk
          // script, which is early enough for both the capture and the buffer flush.
          var resume = function () {
            try {
              captureWebpack();
              flush('runtime hooked');
            } catch (e) { fail('runtime resume: ' + (e && e.message)); }
          };
          if (typeof Promise === 'function') Promise.resolve().then(resume);
          else setTimeout(resume, 0);
        },
      });

      state.hooksInstalled = true;
      note('jsonp push intercepted');
    } catch (e) {
      fail('install: ' + (e && e.message));
    }
  }

  /* ------------------------------------------------------------ framework ---- */

  var frameworkStarted = false;
  function startFramework() {
    if (frameworkStarted) return;
    frameworkStarted = true;
    if (!API) { note('no backend; framework not loaded'); return; }
    if (window.__BNCM_LOADED__ && window.__BNCM_LOADED__.build) { note('framework already present'); return; }
    fetch(API + '/framework.js')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (code) {
        try {
          (new Function(code + '\n//# sourceURL=bncm-framework.js'))();
        } catch (e) { fail('framework eval failed: ' + (e && e.message)); }
      })
      .catch(function (e) { fail('framework fetch failed: ' + (e && e.message)); });
  }

  /** Decide WHEN the framework may run.
   *
   *  This matters more than it looks.  When the preload is injected into an already-loaded page,
   *  the framework can start immediately -- that is the case that has always worked.  When the
   *  preload runs at document-start (which is the case that makes hijacks possible at all), the
   *  framework would otherwise come up at DOMContentLoaded, i.e. WHILE the client is mounting its
   *  React tree, and then load ~1 MB of plugins (RefinedNowPlayingNext alone is 772 KB) that
   *  manipulate that same DOM.  Measured: the app never mounted, with five bare "Script error."
   *  events and nothing else to go on.
   *
   *  So at document-start we wait for `load` plus a short settle, and only then bring plugins up.
   *  Everything the client needs to boot is finished by then; nothing about the hijack path
   *  depends on the framework being early (the preload, not the framework, installs the
   *  interceptor). */
  function scheduleFramework() {
    if (document.readyState === 'complete') { startFramework(); return; }
    if (document.readyState === 'interactive') {
      // Injected late: the app is already up, start now.
      startFramework();
      return;
    }
    // document-start: let the client finish booting first.
    window.addEventListener('load', function () {
      setTimeout(function () { startFramework(); }, 400);
    }, { once: true });
  }

  /* ---------------------------------------------------------------- boot ---- */

  state.intercept = INTERCEPT;
  if (INTERCEPT) {
    install();
    loadRules();
  } else {
    state.passthrough = true;
    state.hooksInstalled = false;
    note('webpack interception disabled (no hijack rule is enabled); preload is a plain bootstrap');
  }
  if (document.readyState === 'loading') {
    scheduleFramework();
  } else {
    startFramework();
  }

  // Late safety net: if a hijack rule arrives after its module already ran (rulesLate), the
  // miss is recorded rather than silently ignored -- see state.missed.
  window.addEventListener('load', checkMissed, { once: true });

  note(BUILD + ' armed at ' + location.href);
})();
