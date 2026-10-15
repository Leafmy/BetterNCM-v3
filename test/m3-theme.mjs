// test/m3-theme.mjs -- Material 3 theme acceptance.
//
// Verifies the things the brief calls out explicitly, as executable assertions rather than prose:
// every authored stylesheet loads by its real path, no phase is silently missing, the scheme is
// internally consistent with the client's own light/dark state, text is readable, the icon font is
// NOT clobbered, and the theme stays out of the other plugins' DOM.
//
// Run: node test/m3-theme.mjs        (requires a running client with the loader attached)

const PORT = Number(process.env.BNCM_PORT || 9222);

/** Run an expression in the client page.  Uses the repo's own CDP helper so this test shares the
 *  exact transport the other suites use (and needs no second implementation to drift). */
async function evaluate(expr) {
  const mod = await import('../tools/cdp_inject.mjs');
  return mod.evaluate(expr, { port: PORT });
}

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}${detail ? '  :: ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  :: ' + detail : ''}`); }
}

async function main() {
  console.log('Material 3 theme acceptance');
  console.log('');

  /* Navigate to a deterministic route FIRST.
   *
   * These assertions used to depend on whatever screen happened to be open, and that made the suite
   * flaky in a way that looked like a theme regression: after test/m3-components.mjs had opened
   * Settings, this suite reported "cmd-button=90" and "no tabs" -- both true of the Settings screen
   * and both irrelevant to whether the theme works.  The playlist route is chosen because it
   * contains both a large cmd-button population and real tabs. */
  await evaluate(`new Promise(function(res){
    function go(){
      var items = Array.prototype.slice.call(document.querySelectorAll('[class*="ItemContainer"]'));
      var t = items.filter(function(e){ return (e.innerText||'').trim() === '我喜欢的音乐'; })[0];
      if (t) { t.click(); return true; }
      return false;
    }
    if (go()) return res('clicked');
    setTimeout(function(){ res(go() ? 'clicked-late' : 'not-found'); }, 2500);
  })`);
  await new Promise((r) => setTimeout(r, 3000));

  const res = await evaluate(`(function(){
    var root = document.documentElement;
    var cs = getComputedStyle(root);
    var v = function(n){ return cs.getPropertyValue(n).trim(); };
    function rgbOf(s){ var m=String(s).match(/(\\d+),\\s*(\\d+),\\s*(\\d+)/); return m?[+m[1],+m[2],+m[3]]:null; }
    function lum(c){ function f(x){ x/=255; return x<=0.04045? x/12.92 : Math.pow((x+0.055)/1.055,2.4);} return 0.2126*f(c[0])+0.7152*f(c[1])+0.0722*f(c[2]); }
    function contrast(a,b){ var la=lum(a),lb=lum(b); return (Math.max(la,lb)+0.05)/(Math.min(la,lb)+0.05); }

    var st = window.__BNCM_M3_THEME__ || null;
    var pal = window.__BNCM_M3_PALETTE__ || null;

    // contrast of the main text against the surface it sits on
    var surfaceEl = document.querySelector('#page_pc_main_tab') || document.body;
    var textEl = document.querySelector('[class*="ItemContainer"]') || surfaceEl;
    var fg = rgbOf(getComputedStyle(textEl).color);
    var bg = rgbOf(getComputedStyle(surfaceEl).backgroundColor);
    var ratio = (fg && bg) ? +contrast(fg, bg).toFixed(2) : null;

    // icon font must still be the client's icon font, not the text stack
    var icon = document.querySelector('.cmd-icon, [class*="IconStyle"]');
    var iconFont = icon ? getComputedStyle(icon).fontFamily : null;
    var bodyFont = getComputedStyle(document.body).fontFamily;

    // the theme must not restyle the other plugins' own DOM
    var lyricBar = document.querySelector('.lyric-bar');
    var lyricBarShadow = lyricBar ? getComputedStyle(lyricBar).boxShadow : null;

    // count stylesheets that actually carry blur/filters or !important (none of ours may).
    // Comments are stripped first: the authored CSS explains at length WHY it avoids !important and
    // blur, and a naive text scan counts those words as violations.  A comment cannot affect
    // rendering, so measuring it would be measuring documentation rather than behaviour.
    var m3Blur = 0, m3Important = 0, m3Sheets = 0;
    Array.prototype.slice.call(document.querySelectorAll('style[data-bncm-m3]')).forEach(function(s){
      var t = (s.textContent || '').replace(/\\/\\*[\\s\\S]*?\\*\\//g, '');
      m3Sheets++;
      // Only an ACTUAL blur counts.  A value of "backdrop-filter: none" is the opposite -- it is us
      // switching blur OFF on the dialog scrim -- so the check looks for blur inside the value
      // rather than for the property name.  (A bare lookahead after whitespace backtracks and
      // matches anyway, which is how this check first reported an anti-blur rule as a violation.)
      var valueBlur = /backdrop-filter\\s*:[^;]*blur/.test(t);
      if (valueBlur || /blur\\(/.test(t)) m3Blur++;
      if (t.indexOf('!important') !== -1) m3Important++;
    });

    return JSON.stringify({
      marked: root.classList.contains('m3-theme'),
      injected: st ? st.injected.length : 0,
      missing: st ? st.missing : ['no-state'],
      failed: st ? st.failed : ['no-state'],
      scheme: v('--md-sys-color-scheme'),
      clientBg: v('--colorBackground'),
      primary: v('--md-sys-color-primary'),
      surface: v('--md-sys-color-surface'),
      contrast: ratio,
      iconFont: iconFont, bodyFont: bodyFont,
      lyricBarPresent: !!lyricBar, lyricBarShadow: lyricBarShadow,
      m3Sheets: m3Sheets, m3Blur: m3Blur, m3Important: m3Important,
      paletteSource: pal ? pal.source : null,
      paletteDark: pal ? pal.dark : null,
      radiusToken: v('--md-sys-shape-corner-large'),
      motionToken: v('--md-sys-motion-page'),
      typeToken: v('--md-sys-typescale-body-medium-size'),
      appRendered: (document.getElementById('root')||{}).childElementCount > 0,
      plugins: (window.__BNCM_LOADED__ && window.__BNCM_LOADED__.plugins || []).map(function(p){ return p.slug + ':' + p.state; }),
      cmd: (function(){
        function count(sel){ return document.querySelectorAll(sel).length; }
        function cs(sel, prop){ var e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : null; }
        return {
          button: count('.cmd-button'), icon: count('.cmd-icon'), typography: count('.cmd-typography'),
          tabs: count('.cmd-tabs'), tab: count('.cmd-tabs-tab'), tabActive: count('.cmd-tabs-tab-active'),
          tag: count('.cmd-tag'), card: count('.cmd-card'), input: count('.cmd-input'), portal: count('.cmd-portal')
        };
      })(),
      cmdButtonRadius: (function(){ var e=document.querySelector('.cmd-button'); return e? getComputedStyle(e).borderRadius : null; })(),
      tabRadius: (function(){ var e=document.querySelector('.cmd-tabs-tab'); return e? getComputedStyle(e).borderRadius : null; })(),
      tabActiveBg: (function(){ var e=document.querySelector('.cmd-tabs-tab-active'); return e? getComputedStyle(e).backgroundColor : null; })(),
      tagRadius: (function(){ var e=document.querySelector('.cmd-tag'); return e? getComputedStyle(e).borderRadius : null; })(),
      cmdTypographyFont: (function(){ var e=document.querySelector('.cmd-typography'); return e? getComputedStyle(e).fontFamily : null; })(),
      mdSecondaryContainer: v('--md-sys-color-secondary-container'),
      paletteBuilds: window.__BNCM_M3_PALETTE__ ? window.__BNCM_M3_PALETTE__.paletteBuilds : null
    });
  })()`);

  const r = JSON.parse(res.value);

  ok('the theme marks the document (html.m3-theme)', r.marked === true);
  ok('every authored stylesheet loaded', r.injected >= 19, `injected=${r.injected}`);
  ok('no stylesheet is missing', Array.isArray(r.missing) && r.missing.length === 0,
     `missing=${JSON.stringify(r.missing)}`);
  ok('no stylesheet failed to load', Array.isArray(r.failed) && r.failed.length === 0,
     `failed=${JSON.stringify(r.failed)}`);

  ok('a full token set is present (colour/radius/motion/type)',
     !!r.primary && !!r.radiusToken && !!r.motionToken && !!r.typeToken,
     `primary=${r.primary} radius=${r.radiusToken} motion=${r.motionToken} type=${r.typeToken}`);

  // light/dark consistency: our scheme must agree with the client's own background
  const bg = (r.clientBg.match(/(\d+),\s*(\d+),\s*(\d+)/) || []).slice(1).map(Number);
  const clientIsDark = bg.length === 3 ? (bg[0] * 0.299 + bg[1] * 0.587 + bg[2] * 0.114) < 128 : null;
  ok('light/dark scheme agrees with the client background',
     clientIsDark === null || (r.scheme === 'dark') === clientIsDark,
     `scheme=${r.scheme} clientBg=${r.clientBg}`);

  ok('body text has readable contrast (>= 4.5)', r.contrast === null || r.contrast >= 4.5,
     `contrast=${r.contrast}`);

  // the icon font must not be replaced by the text stack
  const iconOk = !!r.iconFont && /iconfont|icon|Material Icons/i.test(r.iconFont) &&
                 r.iconFont !== r.bodyFont;
  ok('the icon font is NOT clobbered by the text font', iconOk,
     `icon="${String(r.iconFont).slice(0, 40)}" body="${String(r.bodyFont).slice(0, 30)}"`);

  ok('the theme adds no !important', r.m3Important === 0, `count=${r.m3Important}`);
  ok('the theme adds no blur / backdrop-filter', r.m3Blur === 0, `count=${r.m3Blur}`);

  ok('LyricBar is left alone (no forced shadow)',
     r.lyricBarPresent && (!r.lyricBarShadow || r.lyricBarShadow === 'none'),
     `present=${r.lyricBarPresent} shadow=${r.lyricBarShadow}`);

  ok('the client still renders', r.appRendered === true);
  ok('all four plugins are still loaded', r.plugins.length === 4, r.plugins.join(','));

  /* ---- the client's cmd-* design system --------------------------------------
   *
   * NCM 3.x ships 823 stable `cmd-*` class names covering its whole component library.  They are
   * far better hooks than the CSS-module hashes (which drift per build), and this test pins the
   * ones the theme actually relies on, so a silent selector regression fails here instead of
   * showing up as "some part of the UI looks wrong". */
  console.log('');
  console.log('  client design system (cmd-*):');
  const c = r.cmd || {};
  ok('the client design system is present', (c.button || 0) > 100,
     `cmd-button=${c.button} cmd-icon=${c.icon} cmd-typography=${c.typography}`);
  ok('buttons adopt the M3 shape token', r.cmdButtonRadius === '999px' || r.cmdButtonRadius === '100px',
     `radius=${r.cmdButtonRadius}`);
  ok('tabs adopt the chip radius', r.tabRadius === '8px', `radius=${r.tabRadius}`);
  ok('the active tab uses the scheme secondary-container',
     !!r.tabActiveBg && !!r.mdSecondaryContainer &&
     r.tabActiveBg.replace(/\s/g, '') === hexToRgb(r.mdSecondaryContainer),
     `activeBg=${r.tabActiveBg} role=${r.mdSecondaryContainer}`);
  ok('tags adopt the chip radius', r.tagRadius === '8px', `radius=${r.tagRadius}`);
  ok('cmd-typography uses the theme text stack',
     !!r.cmdTypographyFont && /YaHei|微软雅黑/.test(r.cmdTypographyFont),
     String(r.cmdTypographyFont).slice(0, 40));

  /* ---- phase 8: the palette must not rebuild on every tick ---------------------
   *
   * Motivation, measured: with the theme active a 10s scroll + track-change profile showed 7 long
   * tasks totalling 1305ms, against 6 / 763ms with the theme disabled.  The cause was publish()
   * rebuilding six tonal ladders (~150 Lab->sRGB conversions) on every mutation of <html>'s style
   * attribute -- which the client does constantly while a track loads.  With the (colour, mode) memo
   * in place the same profile reports ONE build, and long-task time fell to 944ms.
   *
   * A regression here would be invisible in the UI and only show up as wasted CPU, which is exactly
   * the kind of thing this project is supposed to prevent, so it is asserted. */
  console.log('');
  console.log('  performance guards:');
  ok('the palette is memoised (not rebuilt per tick)', (r.paletteBuilds || 0) <= 2,
     `paletteBuilds=${r.paletteBuilds}`);
  ok('the theme does not add blur or !important (already checked above)', r.m3Blur === 0 && r.m3Important === 0);
  ok('the theme adds a bounded number of style nodes', (r.m3Sheets || 0) <= 25,
     `m3 style nodes=${r.m3Sheets}`);

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

/** '#584237' -> 'rgb(88,66,55)' so a hex role can be compared with a computed colour. */
function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });
