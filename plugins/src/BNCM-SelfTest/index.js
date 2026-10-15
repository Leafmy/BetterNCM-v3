/* BNCM Self Test -- proves the BetterNCM compatibility layer works on NCM 3.1.41.
 *
 * Every check is isolated and reported, so this plugin doubles as the acceptance test for
 * docs/06-plugin-framework.md.  Results land in window.__BNCM_SELFTEST__ and in the host log.
 */
(function () {
  'use strict';

  var bncm = window.betterncm;
  var results = [];
  function record(name, ok, detail) {
    results.push({ name: name, ok: !!ok, detail: detail === undefined ? null : String(detail) });
    console.log('[selftest] ' + (ok ? 'PASS' : 'FAIL') + ' ' + name + (detail !== undefined ? ' :: ' + detail : ''));
    return ok;
  }

  /* 1. API surface */
  record('betterncm present', !!bncm);
  record('betterncm.version', !!(bncm && bncm.version), bncm && bncm.version);
  record('fs API', !!(bncm && bncm.fs && bncm.fs.readFileText && bncm.fs.writeFileText));
  record('ncm bridge wrapper', !!(bncm && bncm.ncm && typeof bncm.ncm.call === 'function'));
  record('utils.waitForElement', !!(bncm && bncm.utils && bncm.utils.waitForElement));

  /* 2. NCM version visibility */
  var ver = bncm && bncm.ncm && bncm.ncm.version;
  record('ncm.version is 3.1.41.x', /^3\.1\.41/.test(ver || ''), ver);

  /* 3. Native channel availability */
  var chans = (bncm && bncm.ncm && bncm.ncm.channelFunctions) || [];
  record('channel bridge present', chans.length >= 13, chans.length + ' functions');

  /* 4. fs round-trip through the host backend */
  var payload = { at: Date.now(), appver: ver, plugin: 'bncm-selftest' };
  bncm.fs.writeFileText('selftest.json', JSON.stringify(payload, null, 1))
    .then(function () { return bncm.fs.exists('selftest.json'); })
    .then(function (exists) {
      record('fs write + exists', exists);
      return bncm.fs.readFileText('selftest.json');
    })
    .then(function (txt) {
      var back = JSON.parse(txt);
      record('fs read-back matches', back.appver === ver, back.appver);
    })
    .catch(function (e) { record('fs round-trip', false, e.message); });

  /* 5. Real native calls through the client's own bridge.
   *
   * Note: channel.call(name, cb, args) returns a boolean *immediately* and delivers the
   * payload to cb later.  Not every command produces a value -- several (app.getLocalConfig,
   * os.getSystemInfo, network.info) call back with undefined and instead push their data via
   * registerCall events.  So we assert two separate things:
   *   (a) the callback mechanism fires at all, and
   *   (b) a command known to return data actually returns it.
   */
  function nativeCall(cmd, args) {
    return new Promise(function (resolve) {
      var done = false;
      var fin = function (v) { if (!done) { done = true; resolve(v); } };
      try {
        window.channel.call(cmd, function (r) { fin({ fired: true, value: r }); }, args || []);
      } catch (e) { fin({ fired: false, error: e.message }); }
      setTimeout(function () { fin({ fired: false, error: 'timeout' }); }, 4000);
    });
  }

  nativeCall('winhelper.getWindowPosition')
    .then(function (r) { record('bridge callback fires', r.fired, r.error || null); });

  nativeCall('player.getVolume')
    .then(function (r) {
      record('native player.getVolume returns data', r.fired && typeof r.value === 'number',
             r.fired ? (typeof r.value + '=' + r.value) : (r.error || 'no callback'));
    });

  /* 5b. The same call through the framework wrapper. */
  bncm.ncm.call('player.getVolume')
    .then(function (v) { record('betterncm.ncm.call returns data', typeof v === 'number', typeof v + '=' + v); })
    .catch(function (e) { record('betterncm.ncm.call returns data', false, e.message); });

  /* 6. DOM injection */
  try {
    bncm.utils.appendStyle(
      '#__bncm_selftest__{position:fixed;left:12px;bottom:12px;z-index:2147483646;' +
      'font:12px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'background:rgba(20,20,24,.88);color:#f5f5f7;padding:8px 12px;border-radius:6px;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.35);max-width:320px}' +
      '#__bncm_selftest__ b{color:#4ade80}#__bncm_selftest__ i{color:#9a9aa2;font-style:normal}',
      '__bncm_selftest_style__');
    record('CSS injection', !!document.getElementById('__bncm_selftest_style__'));
  } catch (e) { record('CSS injection', false, e.message); }

  /* 7. Host -> page event subscription */
  try {
    var off = bncm.ncm.on('app.onBootFinish', function () { /* would receive boot event */ });
    record('registerCall subscription', typeof off === 'function');
  } catch (e) { record('registerCall subscription', false, e.message); }

  /* 8. Report: panel + host log */
  function report() {
    var passed = results.filter(function (r) { return r.ok; }).length;
    var panel = document.getElementById('__bncm_selftest__');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = '__bncm_selftest__';
      (document.body || document.documentElement).appendChild(panel);
    }
    panel.innerHTML = '<b>BNCM Self Test</b> ' + passed + '/' + results.length + ' passed<br>' +
      results.map(function (r) {
        return '<i>' + (r.ok ? '✔' : '✘') + ' ' + r.name +
               (r.ok || !r.detail ? '' : ' — ' + r.detail) + '</i>';
      }).join('<br>');

    var summary = { build: bncm.build, appver: ver, passed: passed, total: results.length, results: results };
    window.__BNCM_SELFTEST__ = summary;
    console.log('[selftest] ' + passed + '/' + results.length + ' checks passed');
    if (bncm.fs) bncm.fs.writeFileText('selftest-result.json', JSON.stringify(summary, null, 1)).catch(function () {});
    return summary;
  }

  // Let the async checks settle before reporting.
  setTimeout(report, 2500);
})();
