// hijack_probe.mjs -- find the lyric-pipeline module in the RUNNING client, so its hijack rule
// can be authored against the build that is actually installed.
//
// Why this is needed
// ------------------
// RefinedNowPlaying only *defines* window.onProcessLyrics; the single caller is the client's own
// lyrics pipeline.  Upstream made that call exist by rewriting the response body of
// `orpheus://orpheus/pub/core` with a byte-exact fragment of the 2.10.4-era minified code.  On
// 3.1.41 that resource does not exist at all (the entry chunks are runtime~app.bundle / app.chunk
// / subApp.chunk) and the fragment matches nothing -- verified against web.pack 477f8a2.
//
// Re-deriving the pattern by hand means reading a 5 MB minified bundle.  This tool does the
// searching instead: it asks the live page for its webpack module registry and scores every module
// by how much it looks like the lyric pipeline, then writes the candidates to
// out/hijack-candidates.json with enough source context to author `from`/`to`
// in loader/hijacks.json.
//
// Prerequisite: the document-start preload must have run, because that is what captures
// __webpack_require__ (window.__BNCM_WP__).  Start the client through loader\launch.cmd or the
// agent, then run this.
//
// Usage:
//   node tools/hijack_probe.mjs                    # analyse the running client
//   node tools/hijack_probe.mjs --top 20 --size 6000
//   node tools/hijack_probe.mjs --grep "originalLyric"
//   node tools/hijack_probe.mjs --out out/hijack-candidates.json

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluate } from './cdp_inject.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

function parseArgs(argv) {
  const o = {
    port: 9222, host: '127.0.0.1', match: 'orpheus://orpheus/pub/app.html',
    top: 25, size: 4000, grep: null, out: resolve(REPO, 'out', 'hijack-candidates.json'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`missing value for ${a}`); return v; };
    switch (a) {
      case '--port': o.port = Number(next()); break;
      case '--host': o.host = next(); break;
      case '--match': o.match = next(); break;
      case '--top': o.top = Number(next()); break;
      case '--size': o.size = Number(next()); break;
      case '--grep': o.grep = next(); break;
      case '--out': o.out = next(); break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  return o;
}

/** The analysis runs INSIDE the page: shipping the module sources back over CDP is the only way
 *  to see the real code, and scoring there keeps the payload small. */
function buildExpression(o) {
  return `(function () {
    var WP = window.__BNCM_WP__;
    var HJ = window.__BNCM_HIJACK__;
    if (!WP || !WP.modules) {
      return { error: 'window.__BNCM_WP__ is missing: the document-start preload did not run. ' +
               'Start the client through loader\\\\launch.cmd or the agent and retry.',
               hijack: HJ ? { hooksInstalled: HJ.hooksInstalled, webpack: HJ.webpack } : null };
    }
    var SIZE = ${o.size};
    var GREP = ${o.grep ? JSON.stringify(o.grep) : 'null'};

    // Signals are weighted, not binary: the lyric pipeline is the thing that talks about
    // originalLyric/translated/romanisation AND builds timed lines AND is awaited.
    var SIGNALS = [
      ['originalLyric', 10], ['translatedLyric', 8], ['romanLyric', 6], ['dynamicLyric', 6],
      ['yrc', 4], ['klyric', 4], ['tlyric', 4], ['lyric', 3], ['lrc', 2],
      ['LyricLine', 5], ['showLyric', 4], ['currentLyrics', 6], ['onProcessLyrics', 20],
      ['isInterlude', 6], ['unsynced', 4], ['parseLyric', 8], ['processLyric', 8],
      ['await', 1], ['async', 1]
    ];

    var out = [];
    var ids = Object.keys(WP.modules);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var factory = WP.modules[id];
      if (typeof factory !== 'function') continue;
      var src;
      try { src = Function.prototype.toString.call(factory); } catch (e) { continue; }

      var score = 0, hits = [];
      for (var s = 0; s < SIGNALS.length; s++) {
        var name = SIGNALS[s][0], weight = SIGNALS[s][1];
        var count = src.split(name).length - 1;
        if (count > 0) { score += weight * Math.min(count, 4); hits.push(name + 'x' + count); }
      }
      if (GREP && src.indexOf(GREP) === -1) continue;
      if (score <= 0) continue;

      var inCache = WP.cache && WP.cache[id];
      out.push({
        moduleId: String(id),
        score: score,
        bytes: src.length,
        signals: hits,
        executed: !!inCache,
        exportKeys: inCache && inCache.exports && typeof inCache.exports === 'object'
          ? Object.keys(inCache.exports).slice(0, 40) : null,
        source: src.length > SIZE ? src.slice(0, SIZE) + '/* …truncated… */' : src
      });
    }
    out.sort(function (a, b) { return b.score - a.score; });

    return {
      modulesScanned: ids.length,
      cacheSize: WP.cache ? Object.keys(WP.cache).length : null,
      hijack: HJ ? {
        hooksInstalled: HJ.hooksInstalled, rulesReady: HJ.rulesReady, rulesLoaded: HJ.rulesLoaded,
        applied: HJ.applied, missed: HJ.missed, errors: HJ.errors,
      } : null,
      candidates: out.slice(0, ${o.top})
    };
  })()`;
}

/** Also report the module count so an empty result is distinguishable from a broken capture. */
async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('hijack_probe.mjs [--port N] [--top N] [--size BYTES] [--grep SUBSTRING] [--out FILE]');
    return 0;
  }

  const res = await evaluate(buildExpression(o), o).catch((e) => {
    // A missing client is the overwhelmingly common case here, so say what to do about it rather
    // than surfacing "fetch failed".
    if (/fetch failed|ECONNREFUSED|no page target/i.test(e.message)) {
      throw new Error(
        `cannot reach the client's DevTools endpoint at http://${o.host}:${o.port}.\n` +
        '  The probe needs a RUNNING client that was started through the loader, because that is\n' +
        '  what opens the debug port and registers the document-start preload (which captures\n' +
        '  __webpack_require__).\n' +
        '    - unattended: loader\\startup.cmd -Install, then open 网易云音乐\n' +
        '    - dev session: loader\\launch.cmd\n' +
        '  Then re-run: node tools\\hijack_probe.mjs');
    }
    throw e;
  });
  const data = res.value;
  if (!data) throw new Error('no value returned from the page');
  if (data.error) {
    console.error(data.error);
    if (data.hijack) console.error('hijack state:', JSON.stringify(data.hijack));
    return 2;
  }

  const report = {
    probed_at: new Date().toISOString(),
    target: res.target,
    modules_scanned: data.modulesScanned,
    cache_size: data.cacheSize,
    hijack: data.hijack,
    candidates: data.candidates,
  };
  mkdirSync(dirname(o.out), { recursive: true });
  writeFileSync(o.out, JSON.stringify(report, null, 1), 'utf8');

  console.log(`target           : ${res.target}`);
  console.log(`modules scanned  : ${data.modulesScanned}`);
  console.log(`modules executed : ${data.cacheSize}`);
  if (data.hijack) {
    console.log(`hijack applied   : ${JSON.stringify(data.hijack.applied)}`);
    console.log(`hijack missed    : ${JSON.stringify(data.hijack.missed)}`);
  }
  console.log(`candidates       : ${data.candidates.length} (top ${o.top}) -> ${o.out}`);
  console.log('');
  for (const c of data.candidates) {
    console.log(`  module ${String(c.moduleId).padStart(6)}  score ${String(c.score).padStart(4)}  ` +
                `${String(c.bytes).padStart(8)}B  executed=${c.executed ? 'yes' : 'no '}`);
    console.log(`         signals: ${c.signals.join(', ')}`);
  }
  if (!data.candidates.length) {
    console.log('no candidates. If "modules scanned" is 0, the webpack capture failed -- check the');
    console.log('preload state in the plugin manager\'s 诊断 tab (window.__BNCM_HIJACK__).');
  } else {
    console.log('');
    console.log('Next: open the JSON, find the function that processes the lyric payload, and put its');
    console.log('exact source fragment into loader/hijacks.json as builtin:lyrics-hook (from/to),');
    console.log('then set pending:false and record derived_from_pack. See docs/11-hijack-engine.md.');
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
}
