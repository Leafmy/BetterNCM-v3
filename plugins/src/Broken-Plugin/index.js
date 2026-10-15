/* Broken Plugin -- throws on purpose.  If isolation works, this shows as state "error"
 * while BNCM-SelfTest still loads and reports normally. */
(function () {
  'use strict';
  window.__BNCM_BROKEN_RAN__ = true;
  throw new Error('intentional failure: this plugin is meant to fail');
})();
