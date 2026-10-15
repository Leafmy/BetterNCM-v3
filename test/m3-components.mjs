// test/m3-components.mjs -- Material 3 component acceptance.
//
// Verifies the controls that CAN be observed on the live client, by driving the client to the
// screen where they exist (Settings holds inputs/checkboxes/radios/selects/sliders) and then
// measuring COMPUTED styles -- not by reading the stylesheet.
//
// This exists because "the stylesheet contains a rule for X" proved worthless three times in this
// project: a wrong path silently 500'd one file, a `<tr>` assumption matched nothing in a
// virtualized list, and a case-sensitive attribute selector never matched cmd-tabs-tab.  Measured
// computed styles are the only signal that a component is actually themed.
//
// Components that could not be opened in this environment (switch, modal, sidesheet, dropdown,
// popover, tooltip, toast) are REPORTED as unobserved rather than assumed to work -- see docs/13.
//
// Run: node test/m3-components.mjs   (requires a running client with the loader attached)

const PORT = Number(process.env.BNCM_PORT || 9222);

async function evaluate(expr) {
  const mod = await import('../tools/cdp_inject.mjs');
  return mod.evaluate(expr, { port: PORT });
}

let passed = 0, failed = 0;
const notObserved = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}${detail ? '  :: ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  :: ' + detail : ''}`); }
}
function report(name, detail) { console.log(`  --   ${name} not observable here  :: ${detail}`); notObserved.push(name); }

async function main() {
  console.log('Material 3 component acceptance');
  console.log('');

  // 1. drive the client to Settings, where the form controls live
  await evaluate(`(function(){
    var s = document.querySelector('[title="设置"]');
    if (s) s.click();
    return 'clicked';
  })()`);
  await new Promise((r) => setTimeout(r, 2600));

  const res = await evaluate(`(function(){
    function cs(sel, prop){ var e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : null; }
    function count(sel){ return document.querySelectorAll(sel).length; }
    var root = getComputedStyle(document.documentElement);
    function role(n){ return root.getPropertyValue(n).trim(); }
    function hexToRgb(hex){
      var m = /^#([0-9a-f]{6})$/i.exec(String(hex||'').trim());
      if (!m) return null; var n = parseInt(m[1], 16);
      return 'rgb(' + ((n>>16)&255) + ', ' + ((n>>8)&255) + ', ' + (n&255) + ')';
    }
    return JSON.stringify({
      counts: {
        checkbox: count('.cmd-checkbox'), radio: count('.cmd-radio'), input: count('.cmd-input'),
        select: count('.cmd-select'), sliderRail: count('.cmd-slider-rail'),
        sliderHandle: count('.cmd-slider-handle'), switch: count('.cmd-switch'),
        modal: count('.cmd-modal-content'), sidesheet: count('.cmd-sidesheet-content'),
        dropdown: count('.cmd-dropdown'), popover: count('.cmd-popover-wrapper'),
        tooltip: count('[class*="cmd-tooltip"]'), toast: count('.cmd-toast')
      },
      checkboxRadius: cs('.cmd-checkbox','borderRadius'),
      checkboxCheckedBg: cs('.cmd-checkbox-checked','backgroundColor'),
      radioRadius: cs('.cmd-radio','borderRadius'),
      inputRadius: cs('.cmd-input','borderRadius'),
      selectRadius: cs('.cmd-select','borderRadius'),
      sliderRailRadius: cs('.cmd-slider-rail','borderRadius'),
      sliderHandleRadius: cs('.cmd-slider-handle','borderRadius'),
      sliderHandleBg: cs('.cmd-slider-handle','backgroundColor'),
      sliderRailBg: cs('.cmd-slider-rail','backgroundColor'),
      shapeExtraSmall: role('--md-sys-shape-corner-extra-small'),
      shapeSmall: role('--md-sys-shape-corner-small'),
      shapeFull: role('--md-sys-shape-corner-full'),
      shapeSliderTrack: role('--md-sys-shape-slider-track'),
      primary: role('--md-sys-color-primary'),
      primaryRgb: hexToRgb(role('--md-sys-color-primary')),
      outlineVariantRgb: hexToRgb(role('--md-sys-color-outline-variant'))
    });
  })()`);

  const r = JSON.parse(res.value);
  const c = r.counts;

  console.log('  form controls found on the Settings screen:');
  console.log(`    checkbox=${c.checkbox} radio=${c.radio} input=${c.input} select=${c.select} ` +
              `sliderRail=${c.sliderRail} sliderHandle=${c.sliderHandle}`);
  console.log('');

  // ---- checkboxes ----
  if (c.checkbox > 0) {
    ok('checkboxes exist and take the extra-small shape', r.checkboxRadius === r.shapeExtraSmall,
       `radius=${r.checkboxRadius} token=${r.shapeExtraSmall}`);
    if (c.checkbox > 0 && r.checkboxCheckedBg) {
      ok('a checked checkbox uses the scheme primary', r.checkboxCheckedBg === r.primaryRgb,
         `bg=${r.checkboxCheckedBg} primary=${r.primaryRgb}`);
    }
  } else report('cmd-checkbox', 'none rendered on this screen');

  // ---- radios ----
  if (c.radio > 0) {
    ok('radios take the full (pill) shape', r.radioRadius === r.shapeFull,
       `radius=${r.radioRadius} token=${r.shapeFull}`);
  } else report('cmd-radio', 'none rendered on this screen');

  // ---- text inputs ----
  if (c.input > 0) {
    ok('text fields take the input shape', r.inputRadius === r.shapeExtraSmall,
       `radius=${r.inputRadius} token=${r.shapeExtraSmall}`);
  } else report('cmd-input', 'none rendered on this screen');

  // ---- selects ----
  if (c.select > 0) {
    ok('selects take the menu shape', r.selectRadius === r.shapeSmall,
       `radius=${r.selectRadius} token=${r.shapeSmall}`);
  } else report('cmd-select', 'none rendered on this screen');

  // ---- sliders ----
  if (c.sliderRail > 0 || c.sliderHandle > 0) {
    ok('slider rail takes the slider-track shape', r.sliderRailRadius === r.shapeSliderTrack,
       `radius=${r.sliderRailRadius} token=${r.shapeSliderTrack}`);
    ok('slider handle is fully round', r.sliderHandleRadius === r.shapeFull,
       `radius=${r.sliderHandleRadius}`);
    ok('slider handle uses the scheme primary', r.sliderHandleBg === r.primaryRgb,
       `bg=${r.sliderHandleBg} primary=${r.primaryRgb}`);
    ok('slider rail uses the outline-variant role', r.sliderRailBg === r.outlineVariantRgb,
       `bg=${r.sliderRailBg} outline-variant=${r.outlineVariantRgb}`);
  } else report('cmd-slider', 'no slider rendered on this screen');

  // ---- components that this environment cannot open ----
  console.log('');
  console.log('  components not reachable in this environment (reported, NOT assumed):');
  const unverifiable = [
    ['cmd-switch', c.switch, 'no settings screen in this build mounts a switch'],
    ['cmd-modal-content', c.modal, 'no synthetic event opened a modal'],
    ['cmd-sidesheet-content', c.sidesheet, 'no synthetic event opened a side sheet'],
    ['cmd-dropdown', c.dropdown, 'clicking cmd-select did not open the dropdown'],
    ['cmd-popover-wrapper', c.popover, 'no popover trigger reachable'],
    ['cmd-tooltip', c.tooltip, 'hovering did not materialise a tooltip'],
    ['cmd-toast', c.toast, 'no toast was raised'],
  ];
  for (const [name, n, why] of unverifiable) {
    if (!n) report(name, why);
  }

  console.log('');
  console.log(`${passed} passed, ${failed} failed, ${notObserved.length} not observable here`);
  // Not-observable components are NOT failures: they are unverified, and the summary says so.
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });
