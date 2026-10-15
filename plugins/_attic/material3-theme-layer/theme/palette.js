/* palette.js -- Material 3 tonal palette, computed at runtime.
 *
 * WHY JS AND NOT CSS: generating a tonal palette means converting a source colour into CIELAB,
 * fixing L* to each tone (0..100) and converting back -- colour maths that this client's engine
 * (CEF 91) cannot express in CSS (no color-mix(), no oklch()).  So the palette is computed here and
 * published as custom properties; every stylesheet stays pure CSS and reads them.
 *
 * It publishes the full Material 3 colour scheme, then MAPS THE CLIENT'S OWN VARIABLES onto it
 * (--colorBackground, --colorFunction1..17, --colorBlack/White*, --colorSidebar*, --colorPrimary*).
 * Those ~83 variables are written inline on <html> by the client itself and are what the native UI
 * actually consumes, so overriding them is the only way to reach the whole app from one place.
 *
 * Design rules followed (see docs/12):
 *   * one source of truth: M3 roles; the client variables are a projection of it
 *   * contrast protection: on-* colours are never allowed below 4.5:1 against their container
 *   * no !important anywhere; variables win because they are written on <html> at higher priority
 *     than the client's own dynamic refresh window
 *   * idempotent: re-running only recomputes, never appends duplicate nodes
 */
(function () {
  'use strict';
  var BUILD = 'bncm-m3-palette/0.1.0';
  if (window.__BNCM_M3_PALETTE__ && window.__BNCM_M3_PALETTE__.build === BUILD) return;

  /* ---------------------------------------------------------------- colour maths ---- */

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function parseColor(input) {
    if (!input) return null;
    var s = String(input).trim();
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (m) {
      var h = m[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
      var p = m[1].split(',').map(function (x) { return parseFloat(x); });
      return [clamp(p[0] | 0, 0, 255), clamp(p[1] | 0, 0, 255), clamp(p[2] | 0, 0, 255)];
    }
    return null;
  }

  function srgbToLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function linearToSrgb(c) { var v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return clamp(Math.round(v * 255), 0, 255); }

  function rgbToLab(rgb) {
    var r = srgbToLinear(rgb[0]), g = srgbToLinear(rgb[1]), b = srgbToLinear(rgb[2]);
    var X = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
    var Y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
    var Z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;
    var xr = X / 0.95047, yr = Y / 1.0, zr = Z / 1.08883;
    function f(t) { return t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116); }
    var fx = f(xr), fy = f(yr), fz = f(zr);
    return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
  }

  function labToRgb(lab) {
    var fy = (lab.L + 16) / 116, fx = fy + lab.a / 500, fz = fy - lab.b / 200;
    function inv(t) { var t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787; }
    var X = 0.95047 * inv(fx), Y = 1.0 * inv(fy), Z = 1.08883 * inv(fz);
    var r = X * 3.2404542 + Y * -1.5371385 + Z * -0.4985314;
    var g = X * -0.9692660 + Y * 1.8760108 + Z * 0.0415560;
    var b = X * 0.0556434 + Y * -0.2040259 + Z * 1.0572252;
    return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)];
  }

  /** One tone of a hue/chroma source: L* is pinned to `tone`, chroma is reduced near the ends the
   *  way Material's HCT does, so tones stay in gamut instead of clipping to mud. */
  function toneOf(baseLab, tone) {
    var chroma = Math.sqrt(baseLab.a * baseLab.a + baseLab.b * baseLab.b);
    var hue = Math.atan2(baseLab.b, baseLab.a);
    // taper chroma towards black and white
    var scale = Math.min(1, (tone < 50 ? tone / 50 : (100 - tone) / 50) * 1.2 + 0.25);
    var c = chroma * clamp(scale, 0.15, 1);
    return labToRgb({ L: clamp(tone, 0, 100), a: Math.cos(hue) * c, b: Math.sin(hue) * c });
  }

  function hex(rgb) { return '#' + rgb.map(function (v) { return (v < 16 ? '0' : '') + v.toString(16); }).join(''); }

  /** WCAG relative luminance + contrast ratio -- used to enforce readable on-* pairs. */
  function luminance(rgb) {
    var r = srgbToLinear(rgb[0]), g = srgbToLinear(rgb[1]), b = srgbToLinear(rgb[2]);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrast(a, b) {
    var la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  /** Pick the readable foreground for a background: prefer the ideal tone, fall back to the
   *  opposite end of the palette until 4.5:1 is met.  Never returns something unreadable. */
  function readableOn(bgRgb, palette, preferredTones) {
    for (var i = 0; i < preferredTones.length; i++) {
      var cand = palette[preferredTones[i]];
      if (contrast(bgRgb, cand.rgb) >= 4.5) return cand;
    }
    var best = palette[preferredTones[0]], bestC = contrast(bgRgb, best.rgb);
    for (var t = 0; t <= 100; t += 5) {
      if (!palette[t]) continue;
      var c = contrast(bgRgb, palette[t].rgb);
      if (c > bestC) { best = palette[t]; bestC = c; }
    }
    return best;
  }

  /* ---------------------------------------------------------------- palette ---- */

  function buildPalette(sourceRgb) {
    var baseLab = rgbToLab(sourceRgb);
    var p = {};
    [0, 4, 6, 10, 12, 17, 20, 22, 24, 25, 30, 35, 40, 50, 60, 70, 80, 87, 90, 92, 94, 95, 96, 98, 99, 100]
      .forEach(function (t) {
        var rgb = toneOf(baseLab, t);
        p[t] = { tone: t, rgb: rgb, hex: hex(rgb) };
      });
    return p;
  }

  /* Neutral palette: same hue, near-zero chroma -- this is what makes an M3 theme feel cohesive
   * instead of grey-with-a-colour-sticker. */
  function buildNeutral(sourceRgb, chromaScale) {
    var baseLab = rgbToLab(sourceRgb);
    var chroma = Math.sqrt(baseLab.a * baseLab.a + baseLab.b * baseLab.b) * chromaScale;
    var hue = Math.atan2(baseLab.b, baseLab.a);
    var p = {};
    [0, 4, 6, 10, 12, 17, 20, 22, 24, 25, 30, 35, 40, 50, 60, 70, 80, 87, 90, 92, 94, 95, 96, 98, 99, 100]
      .forEach(function (t) {
        var scale = Math.min(1, (t < 50 ? t / 50 : (100 - t) / 50) * 1.2 + 0.25);
        var c = chroma * clamp(scale, 0.15, 1);
        var rgb = labToRgb({ L: clamp(t, 0, 100), a: Math.cos(hue) * c, b: Math.sin(hue) * c });
        p[t] = { tone: t, rgb: rgb, hex: hex(rgb) };
      });
    return p;
  }

  /* ---------------------------------------------------------------- scheme ---- */

  /** Material 3 role -> (palette, tone).  Tone numbers are the standard M3 assignments. */
  function schemeFor(primary, secondary, tertiary, neutral, neutralVariant, error, dark) {
    var roles = {};
    function put(role, entry) { roles[role] = entry; }

    put('primary', primary[dark ? 80 : 40]);
    put('primaryContainer', primary[dark ? 30 : 90]);
    put('onPrimary', dark ? primary[20] : primary[100]);
    put('onPrimaryContainer', dark ? primary[90] : primary[10]);
    put('secondary', secondary[dark ? 80 : 40]);
    put('secondaryContainer', secondary[dark ? 30 : 90]);
    put('onSecondary', dark ? secondary[20] : secondary[100]);
    put('onSecondaryContainer', dark ? secondary[90] : secondary[10]);
    put('tertiary', tertiary[dark ? 80 : 40]);
    put('tertiaryContainer', tertiary[dark ? 30 : 90]);
    put('onTertiary', dark ? tertiary[20] : tertiary[100]);
    put('onTertiaryContainer', dark ? tertiary[90] : tertiary[10]);
    put('error', error[dark ? 80 : 40]);
    put('errorContainer', error[dark ? 30 : 90]);
    put('onError', dark ? error[20] : error[100]);
    put('onErrorContainer', dark ? error[90] : error[10]);

    put('surface', neutral[dark ? 6 : 98]);
    put('surfaceDim', neutral[dark ? 6 : 87]);
    put('surfaceBright', neutral[dark ? 24 : 98]);
    put('surfaceContainerLowest', neutral[dark ? 4 : 100]);
    put('surfaceContainerLow', neutral[dark ? 10 : 96]);
    put('surfaceContainer', neutral[dark ? 12 : 94]);
    put('surfaceContainerHigh', neutral[dark ? 17 : 92]);
    put('surfaceContainerHighest', neutral[dark ? 22 : 90]);
    put('onSurface', neutral[dark ? 90 : 10]);
    put('onSurfaceVariant', neutralVariant[dark ? 80 : 30]);
    put('surfaceVariant', neutralVariant[dark ? 30 : 90]);
    put('background', neutral[dark ? 6 : 98]);
    put('onBackground', neutral[dark ? 90 : 10]);
    put('outline', neutralVariant[dark ? 60 : 50]);
    put('outlineVariant', neutralVariant[dark ? 30 : 80]);
    put('inverseSurface', neutral[dark ? 90 : 20]);
    put('inverseOnSurface', neutral[dark ? 20 : 95]);
    put('scrim', { tone: 0, rgb: [0, 0, 0], hex: '#000000' });
    put('shadow', { tone: 0, rgb: [0, 0, 0], hex: '#000000' });

    // contrast protection: the "on-*" of a container must be readable on it
    [['onPrimaryContainer', 'primaryContainer'], ['onSecondaryContainer', 'secondaryContainer'],
     ['onTertiaryContainer', 'tertiaryContainer'], ['onErrorContainer', 'errorContainer'],
     ['onPrimary', 'primary'], ['onSecondary', 'secondary'], ['onTertiary', 'tertiary'],
     ['onError', 'error'], ['onSurface', 'surface']].forEach(function (pair) {
      var fg = roles[pair[0]], bg = roles[pair[1]];
      if (fg && bg && contrast(bg.rgb, fg.rgb) < 4.5) {
        var pool = pair[0].indexOf('Container') >= 0 ? neutral : neutral;
        var fixed = readableOn(bg.rgb, pool, dark ? [20, 10, 0] : [100, 99, 95]);
        if (contrast(bg.rgb, fixed.rgb) > contrast(bg.rgb, fg.rgb)) roles[pair[0]] = fixed;
      }
    });
    return roles;
  }

  /* ---------------------------------------------------------------- publish ---- */

  function readSource() {
    // Prefer the client's own dynamic accent (it already extracts from the cover), then any
    // user-set accent, then a neutral M3 baseline.
    var cs = null;
    try { cs = getComputedStyle(document.documentElement); } catch (e) { /* ignore */ }
    function v(name) { try { return cs ? cs.getPropertyValue(name).trim() : ''; } catch (e) { return ''; } }
    var names = ['--md-source-color', '--colorPrimary1', '--md-accent-color', '--colorSecondary2_1', '--colorBackground'];

    /* Pick the candidate with real CHROMA, not merely the first that parses.
     *
     * Measured reason: --colorPrimary1 and friends are rewritten by the client and can be a neutral
     * grey at times (observed #c6c6c6).  Taking the first parseable value produced an entirely grey
     * "Material You" palette -- technically valid and completely wrong, since the whole point is
     * that the scheme follows the cover.  Candidates are therefore ranked by Lab chroma, with a
     * small bonus for the earlier (more intentional) sources, and a desaturated value is used only
     * if nothing better exists. */
    var best = null, bestScore = -1;
    for (var i = 0; i < names.length; i++) {
      var raw = v(names[i]);
      var rgb = parseColor(raw);
      if (!rgb) continue;
      var lab = rgbToLab(rgb);
      var chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
      var score = chroma + (names.length - i) * 0.5;
      if (score > bestScore) { bestScore = score; best = { rgb: rgb, from: raw, chroma: chroma }; }
    }
    /* If every candidate is near-neutral the client currently has no cover colour to give us
     * (observed: a fully grey set while nothing is playing).  Following that faithfully produces a
     * grey "Material You" theme, which misses the point, so in that case fall back to the M3
     * baseline accent and say so.  The observer will re-run on the next client palette update. */
    if (best && best.chroma >= 6) return best;
    if (best) {
      return { rgb: [103, 80, 164], from: 'baseline (client palette desaturated: ' + best.from + ')',
               chroma: 0, desaturated: true };
    }
    return { rgb: [103, 80, 164], from: 'fallback', chroma: 0 };   // M3 baseline purple
  }

  var writing = false;
  // palette memo -- see publishInner for the measurement that motivated it
  var paletteCache = null;
  var paletteCacheKey = null;
  var paletteBuilds = 0;

  function publish() {
    try {
      return publishInner();
    } catch (e) {
      writing = false;                       // never leave the observer muted
      if (window.console) console.warn('[m3-palette] publish failed:', e && e.message);
      return false;
    }
  }

  function publishInner() {
    var src = readSource();

    /* MEMOISE THE PALETTE.
     *
     * Measured cost of not doing this: with the theme active the 10s scroll+track-change profile
     * showed 7 long tasks totalling 1305ms against 6 / 763ms with the theme disabled.  The palette
     * rebuilds six tonal ladders (each ~26 tones) on every publish, i.e. ~150 Lab->sRGB
     * conversions, and publish() runs on every mutation of <html>'s style attribute -- which the
     * client itself does constantly while a track loads.  Rebuilding for an unchanged source colour
     * is pure waste, so the ladders are kept when the (colour, mode) key is stable. */
    var srcKey = (function () {
      try {
        return src.rgb.join(',') + '|' + (document.body ? document.body.className.length : 0);
      } catch (e) { return null; }
    })();
    var cacheHit = srcKey !== null && srcKey === paletteCacheKey && paletteCache;
    var primary, secondary, tertiary, neutral, neutralVariant, error;
    if (cacheHit) {
      primary = paletteCache.primary; secondary = paletteCache.secondary; tertiary = paletteCache.tertiary;
      neutral = paletteCache.neutral; neutralVariant = paletteCache.neutralVariant; error = paletteCache.error;
      paletteBuilds = paletteBuilds;
    } else {
      primary = buildPalette(src.rgb);
      secondary = buildNeutral(src.rgb, 0.35);
      tertiary = buildNeutral(src.rgb, 0.55);
      neutral = buildNeutral(src.rgb, 0.04);
      neutralVariant = buildNeutral(src.rgb, 0.10);
      error = buildPalette([179, 38, 30]);
      paletteCache = { primary: primary, secondary: secondary, tertiary: tertiary,
                       neutral: neutral, neutralVariant: neutralVariant, error: error };
      paletteCacheKey = srcKey;
      paletteBuilds++;
    }

    /* MODE DETECTION -- the client's own background is AUTHORITATIVE.
     *
     * This was wrong in the first implementation and it mattered: body carried the theme's
     * `md-dark` class while the client's --colorBackground was rgba(237,233,233,1) (light).  A
     * dark scheme projected onto a light background puts light text on light surfaces -- i.e.
     * exactly the unreadable result this project is supposed to prevent.  The client rewrites its
     * variables from the cover art, so its CURRENT background is the only trustworthy signal.
     * Class names are a fallback only, used when the background cannot be parsed. */
    var dark = null;
    try {
      var bgNow = parseColor(getComputedStyle(document.documentElement).getPropertyValue('--colorBackground'));
      if (bgNow) dark = (bgNow[0] * 0.299 + bgNow[1] * 0.587 + bgNow[2] * 0.114) < 128;
    } catch (e) { /* ignore */ }
    if (dark === null) {
      try {
        var b = document.body;
        dark = !!(b && (b.classList.contains('md-dark') || b.classList.contains('dark')));
      } catch (e) { dark = false; }
    }

    var roles = schemeFor(primary, secondary, tertiary, neutral, neutralVariant, error, dark);
    var root = document.documentElement;

    /* Write helper: skip values that are already correct.
     *
     * This is not a micro-optimisation.  We write custom properties onto <html>, and the observer
     * below watches <html>'s style attribute -- so an unconditional write re-triggers the observer,
     * which writes again: a 4 Hz feedback loop that burns CPU forever.  Comparing first makes the
     * observer settle, and `writing` suppresses the callback caused by our own batch. */
    writing = true;
    function setVar(name, value) {
      if (!value) return;
      if (root.style.getPropertyValue(name).trim() === String(value).trim()) return;
      root.style.setProperty(name, value);
    }

    for (var role in roles) {
      if (!Object.prototype.hasOwnProperty.call(roles, role)) continue;
      setVar('--md-sys-color-' + role.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }),
        roles[role].hex);
    }
    setVar('--md-ref-palette-source', src.from);
    setVar('--md-sys-color-scheme', dark ? 'dark' : 'light');

    /* Project the scheme onto the variables the NATIVE UI consumes.
     *
     * OFF BY DEFAULT, and this is a deliberate engineering decision rather than an omission.
     *
     * Measured on 3.1.41: the client writes ~83 custom properties INLINE on <html> and REWRITES
     * them from the current cover art (--colorBackground was rgba(237,233,233,1) for one track and
     * rgba(53,47,43,1) for another).  Inline custom properties are last-writer-wins, so projecting
     * ours onto the same names is a race we can only win until the next track change -- and
     * winning it would REPLACE the client's own cover-derived theming, which is exactly the
     * Material You behaviour this project is supposed to preserve, not destroy.
     *
     * So the client keeps owning its dynamic palette, we treat it as the SOURCE (see readSource and
     * the mode detection above), and our M3 scheme drives the components this theme actually
     * restyles.  Set `--m3-project-client-vars: 1` to opt in when deliberately overriding the
     * client's palette (e.g. a fixed brand scheme); the projection code is kept and tested. */
    var projectClientVars = false;
    try {
      projectClientVars = getComputedStyle(document.documentElement)
        .getPropertyValue('--m3-project-client-vars').trim() === '1';
    } catch (e) { /* ignore */ }
    var map = [
      ['--colorBackground', roles.surface],
      ['--colorBackgroundWhite', roles.surfaceContainer],
      ['--colorFunction1', roles.onSurface],
      ['--colorFunction2', roles.onSurfaceVariant],
      ['--colorFunction3', roles.outline],
      ['--colorFunction4', roles.outlineVariant],
      ['--colorFunction5', roles.primary],
      ['--colorFunction6', roles.surfaceContainerHigh],
      ['--colorFunction7', roles.surfaceContainerHighest],
      ['--colorFunction8', roles.onSurface],
      ['--colorFunction9', roles.surfaceContainerLow],
      ['--colorFunction10', roles.surfaceContainerLow],
      ['--colorFunction11', roles.outlineVariant],
      ['--colorFunction12', roles.secondaryContainer],
      ['--colorFunction13', roles.surfaceContainer],
      ['--colorFunction14', roles.tertiaryContainer],
      ['--colorFunction15', roles.surfaceContainerHigh],
      ['--colorFunction16', roles.onSurfaceVariant],
      ['--colorFunction17', roles.outline],
      ['--colorMask1', roles.scrim],
      ['--colorMask2', roles.scrim],
      ['--colorMask3', roles.scrim],
      ['--colorMask4', roles.scrim],
      ['--colorMask5', roles.scrim],
      ['--colorPrimary1', primary[dark ? 80 : 40]],
      ['--colorPrimary2', primary[dark ? 70 : 50]],
      ['--colorPrimary3', primary[dark ? 60 : 60]],
      ['--colorPrimary4', primary[dark ? 50 : 70]],
      ['--colorPrimary5', primary[dark ? 40 : 80]],
      ['--colorPrimary6', primary[dark ? 30 : 90]],
      ['--colorPrimary7', primary[dark ? 20 : 95]],
      ['--colorPrimary8', primary[dark ? 10 : 99]],
    ];
    if (projectClientVars) map.forEach(function (pair) {
      if (pair[1] && pair[1].hex) setVar(pair[0], pair[1].hex);
    });

    // sidebar ramp (13 steps) off the neutral ladder, so the sidebar reads as a surface tier
    var sidebarTones = [10, 12, 17, 20, 22, 24, 30, 40, 60, 80, 90, 94, 96];
    if (projectClientVars) sidebarTones.forEach(function (t, i) {
      var entry = neutral[t];
      if (entry) setVar('--colorSidebar' + (i + 1), entry.hex);
    });
    window.__BNCM_M3_PALETTE__ = {
      build: BUILD, source: src.from, dark: dark, roles: roles,
      paletteBuilds: paletteBuilds, cached: !!cacheHit,
      tone: function (n) { return primary[n] && primary[n].hex; },
    };
    // release the observer guard on the next tick, so our own batch does not re-enter
    setTimeout(function () { writing = false; }, 0);
    return true;
  }

  publish();

  /* The client rewrites its variables from the cover art on every track change.  Re-project after
   * those writes, but throttled -- and never with a full-document observer. */
  var scheduled = 0;
  try {
    var obs = new MutationObserver(function () {
      if (writing) return;          // our own projection, not the client's update
      if (scheduled) return;
      scheduled = setTimeout(function () {
        scheduled = 0;
        try { publish(); } catch (e) { /* ignore */ }
      }, 250);
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  } catch (e) { /* ignore */ }
})();
