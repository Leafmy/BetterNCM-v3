// compat_report.mjs -- snapshot which plugins load against a running client, as JSON.
//
// The compatibility matrix in docs/05-compat-matrix.md has to be re-checked whenever NetEase
// ships a new client or web bundle.  This turns that into one command:
//
//   1. loader\launch.cmd -PluginsDir C:\betterncm\plugins -Duration 90 -Force
//   2. node tools\compat_report.mjs --out docs/real-plugin-compat.json
//
// It only reads the page; it never touches the plugin archives.
//
// Since the 0.3.0 framework it also records what used to be invisible: which plugins are CORE
// (built in, unremovable), which hijacks actually landed, whether the document-start preload
// hooked webpack, and whether each plugin's onConfig produced a settings element.  Those are the
// four things that silently read as "fine" while the feature was dead.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluate } from './cdp_inject.mjs';

const EXPR = `(function () {
  var L = window.__BNCM_LOADED__ || {};
  var HJ = window.__BNCM_HIJACK__ || null;
  var INJ = (window.betterncm && window.betterncm.injector) || null;
  var ps = L.plugins || [];
  return JSON.stringify({
    appver: L.appver || null,
    framework: L.build || null,
    backend: L.backend || null,
    core_slugs: L.core || [],
    channel_functions: (L.channelFunctions || []).length,
    dbg_command: !!L.dbgCommand,
    globals: {
      h: typeof window.h, f: typeof window.f, dom: typeof window.dom,
      betterncmFetch: typeof window.betterncmFetch,
      React: typeof window.React, ReactDOM: typeof window.ReactDOM,
      legacyNativeCmder: !!(window.legacyNativeCmder && window.legacyNativeCmder.appendRegisterCall),
      WPRequire: !!(window.__BNCM_WP__ && window.__BNCM_WP__.require),
      loadedPlugins: Array.isArray(window.loadedPlugins) ? window.loadedPlugins.length : null,
      // Slug-addressable loadedPlugins is what RefinedNowPlaying and LyricBar read; an array
      // alone used to make every one of those probes silently undefined.
      loadedPluginsBySlug: (window.loadedPlugins && window.loadedPlugins.RefinedNowPlaying)
        ? 'RefinedNowPlaying' : null,
    },
    injector: INJ ? { preload: INJ.preload, webpack: INJ.webpack, react: INJ.react,
                      reactDom: INJ.reactDom, legacyNativeCmder: INJ.legacyNativeCmder,
                      selectors: INJ.selectors } : null,
    hijacks: HJ ? { hooksInstalled: HJ.hooksInstalled, rulesReady: HJ.rulesReady,
                    rulesLoaded: HJ.rulesLoaded, rulesLate: HJ.rulesLate,
                    modulesSeen: HJ.modulesSeen, modulesRewritten: HJ.modulesRewritten,
                    applied: HJ.applied, wrapped: HJ.wrapped, missed: HJ.missed,
                    errors: HJ.errors } : null,
    playing: (function () {
      try { var p = window.betterncm.ncm.getPlaying(); return { id: typeof p.id, title: typeof p.title }; }
      catch (e) { return { error: String(e && e.message) }; }
    })(),
    plugins: ps
  });
})()`;

function parseArgs(argv) {
  const o = { out: resolve('docs', 'real-plugin-compat.json'), json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') o.out = argv[++i];
    else if (argv[i] === '--json') o.json = true;
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const res = await evaluate(EXPR);
  const data = JSON.parse(res.value);
  const ps = data.plugins || [];
  const counts = ps.reduce((a, p) => (a[p.state] = (a[p.state] || 0) + 1, a), {});
  const core = ps.filter((p) => p.core);
  const withConfig = ps.filter((p) => p.hooks && p.hooks.onConfig);

  const report = {
    captured_at: new Date().toISOString(),
    ncm_version: data.appver,
    framework: data.framework,
    backend: data.backend,
    core_slugs: data.core_slugs || [],
    channel_functions: data.channel_functions,
    dbg_command: data.dbg_command,
    globals: data.globals,
    injector: data.injector,
    hijacks: data.hijacks,
    playing_probe: data.playing,
    counts,
    core_counts: {
      total: core.length,
      loaded: core.filter((p) => p.state === 'loaded').length,
    },
    plugins_with_config: withConfig.length,
    total: ps.length,
    plugins: ps.slice().sort((a, b) => String(a.slug).localeCompare(String(b.slug))),
  };

  mkdirSync(dirname(o.out), { recursive: true });
  writeFileSync(o.out, JSON.stringify(report, null, 1), 'utf8');
  console.log(`ncm ${report.ncm_version}  framework ${report.framework}`);
  console.log(`plugins: ${report.total}  ->  ` +
    Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log(`core   : ${report.core_counts.loaded}/${report.core_counts.total} loaded` +
    (report.core_slugs.length ? `  (${report.core_slugs.join(', ')})` : ''));
  console.log(`onConfig elements: ${report.plugins_with_config}/${report.total}`);
  if (data.injector) {
    console.log(`injector: preload=${data.injector.preload || 'MISSING'} webpack=${data.injector.webpack} ` +
                `React=${data.injector.react} ReactDOM=${data.injector.reactDom}`);
  }
  if (data.hijacks) {
    const hj = data.hijacks;
    console.log(`hijacks: ${(hj.applied || []).length} applied, ${(hj.missed || []).length} missed` +
                `${hj.rulesLate ? '  (rules arrived late)' : ''}`);
    if ((hj.missed || []).length) console.log(`         MISSED: ${hj.missed.join(', ')}`);
  }
  console.log('');
  for (const p of report.plugins) {
    const mark = p.state === 'loaded' ? 'ok  ' : p.state === 'skipped' ? 'skip' : 'FAIL';
    const tag = p.core ? ' [core]' : '';
    console.log(`  ${mark} ${String(p.slug).padEnd(34)} ${String(p.version || '').padEnd(8)}${tag}` +
      `${p.error ? ' ' + String(p.error).slice(0, 70) : ''}`);
  }
  console.log('');
  console.log(`written: ${o.out}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
}
