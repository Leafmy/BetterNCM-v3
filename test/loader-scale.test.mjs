/* loader-scale.test.mjs -- does the plugin loader stay smooth as plugins are ADDED?
 *
 * The loader used to be a strictly serial chain: `chain = chain.then(() => loadPlugin(p))`.  With
 * one plugin that is invisible.  With sixty it means boot time is the SUM of sixty scripts'
 * fetch+eval, and it means one plugin whose script never arrives (a hung host, a file the antivirus
 * is scanning, a plugin with a monster bundle) blocks every plugin behind it forever.  Neither
 * shows up in a suite where every fetch resolves in the same microtask.
 *
 * This suite models the I/O shape (latency, hangs, failures) and pins the properties that make the
 * loader scale-independent:
 *
 *   1. script fetches are CONCURRENT (bounded), so boot is O(N/concurrency) not O(N) in I/O;
 *   2. a hung or failing plugin is TIMED OUT and quarantined, never allowed to stall the others;
 *   3. load order stays deterministic: core before user, `loadAfter` respected;
 *   4. a plugin whose lifecycle hook throws or is pathologically slow cannot take other plugins
 *      down with it, and it is REPORTED (per-plugin timings);
 *   5. the whole thing is observable from the page (`betterncm.loader.stats()`).
 *
 * Run: node test/loader-scale.test.mjs
 */
import { coreEntry, userEntry, makeWorld, waitFor, waitForPlugins, bySlug, fmt } from './lib/bncm-harness.mjs';

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function eq(name, a, b) { ok(name, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const range = (n) => Array.from({ length: n }, (_, i) => i);

async function main() {
  console.log('loader scale');

  /* ---- 1. boot cost is driven by concurrency, not by plugin count ---------- */
  // 25 ms per script: comfortably above timer granularity on Windows (~15.6 ms), so the wall
  // clock measures the LOADER's structure rather than the host OS timer resolution.
  const N = 60, LAT = 25;
  {
    const t0 = Date.now();
    const w = makeWorld({
      core: [coreEntry('CoreBoot')],
      plugins: range(N).map((i) => userEntry('P' + i)),
      latency: LAT,
      pluginCode: () => '/* boot */',
    });
    let settled = true;
    try { await waitForPlugins(w, N + 1, 15000); } catch { settled = false; }
    const wall = Date.now() - t0;
    const perf = w.stats() || {};
    const boot = typeof perf.total_ms === 'number' ? perf.total_ms : wall;
    // Serial loading would need at least (N+1) * LAT just for the fetches.
    const serialFloor = (N + 1) * LAT;
    const conc = w.inflight.scriptMax;
    console.log(`       N=${N} latency=${LAT}ms -> boot ${fmt(boot)} wall ${fmt(wall)} ` +
                `(serial floor ${fmt(serialFloor)}), max scripts in flight ${conc}, ` +
                `reported concurrency ${perf.concurrency}`);

    ok('all plugins loaded', settled && (w.win.__BNCM_LOADED__.plugins || []).length === N + 1);
    ok(`script fetches are concurrent (${conc} in flight at once)`, conc >= 3);
    ok(`boot is well under the serial floor (${fmt(boot)} < ${fmt(serialFloor * 0.4)})`,
       boot < serialFloor * 0.4, `boot=${fmt(boot)}`);
    ok('the loader reports the concurrency it used',
       typeof perf.concurrency === 'number' && perf.concurrency >= 3, String(perf.concurrency));
    w.dispose();
  }

  /* ---- 2. a HUNG script must not stall the rest of the load --------------- */
  {
    const w = makeWorld({
      core: [coreEntry('CoreHang')],
      plugins: range(20).map((i) => userEntry('H' + i)),
      latency: 2,
      config: { fetchTimeoutMs: 300 },
      hang: (slug) => slug === 'H7',
    });
    const t0 = Date.now();
    let done = true;
    try { await waitForPlugins(w, 21, 9000); } catch { done = false; }
    const wall = Date.now() - t0;
    const list = w.win.__BNCM_LOADED__.plugins || [];
    const by = bySlug(list);
    const others = list.filter((p) => p.slug !== 'H7');
    console.log(`       20 plugins with one hanging script -> settled=${done} in ${fmt(wall)}; H7=${by.H7 && by.H7.state}`);

    ok('the load completes despite one never-answering script', done);
    ok('every other plugin still loaded',
       others.length === 20 && others.every((p) => p.state === 'loaded'),
       JSON.stringify(others.filter((p) => p.state !== 'loaded').map((p) => p.slug + ':' + p.state)));
    ok('the hung plugin is quarantined as an error',
       !!by.H7 && by.H7.state === 'error', JSON.stringify(by.H7 || null));
    ok('... and the error names the timeout',
       !!by.H7 && /timeout|timed out|abort/i.test(String(by.H7.error)), by.H7 && by.H7.error);
    ok('... and how many timed out is reported',
       !!w.stats() && (w.stats().timeouts || []).indexOf('H7') !== -1,
       JSON.stringify(w.stats() && w.stats().timeouts));
    ok(`the timeout is respected (settled in ${fmt(wall)}, budget 300ms + overhead)`, wall < 3000);
    w.dispose();
  }

  /* ---- 3. a FAILING fetch is isolated too --------------------------------- */
  {
    const w = makeWorld({
      core: [],
      plugins: [userEntry('OK1'), userEntry('Bad'), userEntry('OK2')],
      fail: (slug) => (slug === 'Bad' ? 500 : undefined),
    });
    let done = true;
    try { await waitForPlugins(w, 3, 4000); } catch { done = false; }
    const by = bySlug(w.win.__BNCM_LOADED__.plugins);
    ok('a 500 on one plugin does not stop the others',
       done && by.OK1.state === 'loaded' && by.OK2.state === 'loaded', JSON.stringify(by));
    eq('the failing plugin is reported as an error', by.Bad && by.Bad.state, 'error');
    w.dispose();
  }

  /* ---- 4. deterministic order: core first, then loadAfter ----------------- */
  {
    const w = makeWorld({
      core: [coreEntry('C1'), coreEntry('C2')],
      // A is listed BEFORE B but declares loadAfter B: B must be evaluated first.
      plugins: [
        userEntry('A', { manifest: { loadAfter: ['B'] } }),
        userEntry('B'),
        userEntry('C'),
      ],
      pluginCode: (slug) => `window.__ORDER__=(window.__ORDER__||[]);window.__ORDER__.push(${JSON.stringify(slug)});`,
    });
    let done = true;
    try { await waitForPlugins(w, 5, 4000); } catch { done = false; }
    const order = w.win.__ORDER__ || [];
    console.log(`       evaluation order: ${order.join(' -> ')}`);
    ok('all five plugins evaluated', done && order.length === 5, JSON.stringify(order));
    eq('core plugins evaluate first, in list order', order.slice(0, 2).join(','), 'C1,C2');
    ok('loadAfter is honoured for user plugins (B before A)',
       order.indexOf('B') !== -1 && order.indexOf('A') !== -1 && order.indexOf('B') < order.indexOf('A'));
    w.dispose();
  }

  /* ---- 5. lifecycle isolation + per-plugin reporting --------------------- */
  {
    const w = makeWorld({
      core: [],
      plugins: [userEntry('Thrower'), userEntry('Sleeper'), userEntry('Quiet')],
      pluginCode: (slug) => {
        if (slug === 'Thrower') return 'plugin.onLoad(function(){ throw new Error("boom"); });';
        if (slug === 'Sleeper') return 'plugin.onLoad(function(){ var t=Date.now(); while(Date.now()-t<120){} });';
        return 'plugin.onLoad(function(){ window.__QUIET_HOOK__=1; });';
      },
    });
    let done = true;
    try { await waitForPlugins(w, 3, 4000); } catch { done = false; }
    const by = bySlug(w.win.__BNCM_LOADED__.plugins);
    const perf = w.stats() || {};
    const per = bySlug(perf.per_plugin || []);
    console.log(`       hook timings: ` +
      (perf.per_plugin || []).map((p) => `${p.slug}=${Math.round(p.hook_ms || 0)}ms`).join(' '));

    ok('a throwing onLoad is contained', done && by.Thrower.state === 'error' &&
       /boom/.test(String(by.Thrower.error)), JSON.stringify(by.Thrower || null));
    eq('... and its hook is reported as not run', by.Thrower.hooks && by.Thrower.hooks.onLoad, false);
    eq('the other plugins still load', by.Quiet.state, 'loaded');
    eq('... and their onLoad still ran', w.win.__QUIET_HOOK__, 1);
    ok('an over-budget hook is flagged instead of silently blocking the report',
       !!per.Sleeper && Number(per.Sleeper.hook_ms) >= 80 &&
       Array.isArray(perf.slow) && perf.slow.some((s) => s.slug === 'Sleeper' && s.phase === 'hook'),
       JSON.stringify({ sleeper: per.Sleeper, slow: perf.slow }));
    w.dispose();
  }

  /* ---- 6. observability -------------------------------------------------- */
  {
    const w = makeWorld({ core: [coreEntry('Obs')], plugins: [userEntry('Obs1'), userEntry('Obs2')] });
    try { await waitForPlugins(w, 3, 4000); } catch { /* asserted below */ }
    const perf = w.stats();
    const loader = w.win.betterncm.loader;
    ok('__BNCM_LOADED__.perf is published', !!perf);
    ok('perf reports the plugin count and states',
       !!perf && perf.plugins === 3 && perf.loaded === 3, JSON.stringify(perf && { p: perf.plugins, l: perf.loaded }));
    ok('perf carries a per-plugin timing table',
       !!perf && Array.isArray(perf.per_plugin) && perf.per_plugin.length === 3 &&
       perf.per_plugin.every((p) => typeof p.fetch_ms === 'number' && typeof p.eval_ms === 'number' &&
                                   typeof p.load_ms === 'number'));
    ok('perf reports the fetch concurrency actually used',
       !!perf && typeof perf.concurrency === 'number' && perf.concurrency >= 2, JSON.stringify(perf && perf.concurrency));
    ok('betterncm.loader.stats() is the same data',
       !!loader && typeof loader.stats === 'function' && loader.stats().plugins === 3);
    ok('betterncm.loader.config exposes the budget knobs',
       !!loader && !!loader.config && typeof loader.config.concurrency === 'number' &&
       typeof loader.config.fetchTimeoutMs === 'number' && typeof loader.config.yieldBudgetMs === 'number',
       JSON.stringify(loader && loader.config));
    w.dispose();
  }

  /* ---- 7. the budget knobs actually work --------------------------------- */
  {
    const w = makeWorld({
      core: [],
      plugins: range(6).map((i) => userEntry('K' + i)),
      config: { concurrency: 2, fetchTimeoutMs: 500 },
      latency: 20,
    });
    try { await waitForPlugins(w, 6, 4000); } catch { /* asserted below */ }
    const conc = w.inflight.scriptMax;
    const perf = w.stats() || {};
    console.log(`       configured concurrency=2 -> observed max scripts in flight ${conc}, reported ${perf.concurrency}`);
    ok('a configured concurrency cap is respected', conc <= 2, `observed ${conc}`);
    eq('... and is the value reported to the page', perf.concurrency, 2);
    w.dispose();
  }

  /* ---- 9. plugins the gates skip are never downloaded --------------------- */
  {
    const w = makeWorld({
      core: [],
      plugins: [
        ...range(20).map((i) => userEntry('Live' + i)),
        ...range(20).map((i) => userEntry('Off' + i, { disabled: true })),
        userEntry('TooNew', { manifest: { ncm_version_req: '> 99.0.0' } }),
      ],
    });
    try { await waitForPlugins(w, 41, 6000); } catch { /* asserted below */ }
    const perf = w.stats() || {};
    const scriptReqs = w.requests.filter((r) => r.url.indexOf('/api/plugin/') !== -1).length;
    const by = bySlug(w.win.__BNCM_LOADED__.plugins);
    console.log(`       41 plugins, 21 skippable -> ${scriptReqs} script download(s), ` +
                `perf.planned_scripts=${perf.planned_scripts}, perf.skipped_scripts=${perf.skipped_scripts}`);
    eq('only loadable plugins are downloaded', scriptReqs, 20);
    eq('the skipped scripts are reported', perf.skipped_scripts, 21);
    eq('... and the skipped plugins are still reported to the user', by.Off0 && by.Off0.state, 'skipped');
    eq('... including gate skips', by.TooNew && by.TooNew.state, 'skipped');
    ok('all 20 loadable plugins loaded',
       range(20).every((i) => by['Live' + i] && by['Live' + i].state === 'loaded'));
    w.dispose();
  }

  await sleep(20);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
