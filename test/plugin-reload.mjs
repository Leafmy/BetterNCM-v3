/* plugin-reload.mjs -- repeated / concurrent reload requests must produce ONE clean page reload.
 *
 * Why this matters for scale
 * --------------------------
 * Third-party plugins have no teardown hook, so re-evaluating them in place leaves observers,
 * timers, React roots and styles behind -- and the damage compounds with every extra plugin.  The
 * loader therefore runs its plugin pass exactly once per document and turns any later reload
 * request into a single page reload, which is what actually frees the old copies.
 *
 * This used to be checked by slicing `loadAllPlugins` out of framework.js and running it against
 * hand-written stubs.  That is no longer meaningful: the loader now shares real state with the
 * fetch pool, the telemetry and the gate helpers, and a stub context would be testing the stubs.
 * It runs the real framework in the shared fake client instead, so the invariant is checked where
 * it actually lives.
 *
 * Run: node test/plugin-reload.mjs
 */
import assert from 'node:assert/strict';
import { userEntry, makeWorld, waitForPlugins } from './lib/bncm-harness.mjs';

const evaluations = [];
const world = makeWorld({
  core: [],
  plugins: [userEntry('NowPlaying'), userEntry('Theme')],
  pluginCode: (slug) => `window.__EVALS__=(window.__EVALS__||[]);window.__EVALS__.push(${JSON.stringify(slug)});`,
});

try {
  await waitForPlugins(world, 2, 5000);
  // Array.from: the plugin ran inside the vm realm, whose Array prototype differs from this one,
  // and deepStrictEqual compares prototypes.
  assert.deepEqual(Array.from(world.win.__EVALS__), ['NowPlaying', 'Theme'],
                   'the first pass evaluates both plugins');
  assert.equal(world.win.__RELOADED__, undefined, 'booting does not reload the page');

  // One explicit reload, then five concurrent ones: every request must collapse into the same
  // single page reload, and no plugin script may run a second time.
  const r1 = world.win.betterncm.app.reloadPlugins();
  const more = await Promise.all(Array.from({ length: 5 }, () => world.win.betterncm.app.reloadPlugins()));
  await r1;
  await Promise.all(more);
  await new Promise((r) => setTimeout(r, 30));

  assert.deepEqual(Array.from(world.win.__EVALS__), ['NowPlaying', 'Theme'],
                   'no plugin script is evaluated twice');
  assert.equal(world.win.__RELOADED__, 1, 'six reload requests schedule exactly one page reload');
  assert.equal(world.win.__BNCM_LOADED__.perf.per_plugin.length, 2,
               'the telemetry table still describes the single real pass');

  console.log('PASS: repeated/concurrent reload requests schedule one clean page reload ' +
              'without re-executing plugins');
} finally {
  world.dispose();
}
