/* Incompatible Plugin -- must never execute.  If window.__BNCM_INCOMPAT_RAN__ becomes true,
 * the ncm3 gate is not working. */
(function () {
  'use strict';
  window.__BNCM_INCOMPAT_RAN__ = true;
  console.error('[incompatible-plugin] this should NOT have run on NCM 3.x');
})();
