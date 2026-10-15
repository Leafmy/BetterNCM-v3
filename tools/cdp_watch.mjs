// cdp_watch.mjs -- keep the BetterNCM bootstrap present in the NetEase app page.
//
// CDP-injected JavaScript does not survive a page reload or navigation.  This watcher polls
// the page target, checks the canary the bootstrap installs, and re-injects when it is gone.
// It is the persistence layer for the CDP route; the in-process version.dll proxy is the
// longer-term answer.
//
// Usage:
//   node tools/cdp_watch.mjs                              # watch until Ctrl+C
//   node tools/cdp_watch.mjs --once                       # inject if needed, then exit
//   node tools/cdp_watch.mjs --once --shot out\ui.png     # also capture a screenshot
//   node tools/cdp_watch.mjs --interval 3 --duration 60
//
// Requires Node >= 21 (global WebSocket).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluate, fetchTargets, Session } from './cdp_inject.mjs';

// fileURLToPath, not url.pathname: the workspace path contains a space (%20 otherwise).
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FRAMEWORK = resolve(HERE, '..', 'loader', 'framework.js');
const PRELOAD = resolve(HERE, 'bncm_preload.js');

const CANARY = 'typeof window.__BNCM_LOADED__ === "object" && !!window.__BNCM_LOADED__.build';

function parseArgs(argv) {
  const o = { port: 9222, host: '127.0.0.1', match: 'orpheus://orpheus/pub/app.html',
              interval: 3, duration: 0, once: false, shot: null, quiet: false,
              api: null, key: '', ncm3Gate: '', framework: DEFAULT_FRAMEWORK, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`missing value for ${a}`); return v; };
    if (a === '--port') o.port = Number(next());
    else if (a === '--host') o.host = next();
    else if (a === '--match') o.match = next();
    else if (a === '--interval') o.interval = Number(next());
    else if (a === '--duration') o.duration = Number(next());
    else if (a === '--framework' || a === '--bootstrap') o.framework = next();
    else if (a === '--api') o.api = next();
    else if (a === '--key') o.key = next();
    else if (a === '--ncm3-gate') o.ncm3Gate = next();
    else if (a === '--shot') o.shot = next();
    else if (a === '--once') o.once = true;
    else if (a === '--force') o.force = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/** Compose the injected source: backend config first, then the framework itself. */
function buildInjection(o, frameworkSource) {
  const cfg = { api: o.api || null, key: o.key || '', ncm3Gate: o.ncm3Gate || undefined,
                intercept: preloadInterceptEnabled() };
  return 'window.__BNCM_CONFIG__ = ' + JSON.stringify(cfg) + ';\n' + frameworkSource;
}

/** Mirrors tools/bncm_agent.mjs: only interpose on webpack when a rule actually needs it. */
function preloadInterceptEnabled() {
  try {
    const book = JSON.parse(readFileSync(resolve(HERE, '..', 'loader', 'hijacks.json'), 'utf8'));
    return (book.rules || []).some((r) => !r.pending && (r.from || r.locate));
  } catch { return false; }
}

/** Register the document-start preload on this page target.
 *
 *  This is not optional plumbing: the client is a webpack bundle, and the ONLY moment a module
 *  can be rewritten is while its chunk registers -- i.e. before the app scripts run.  Injecting
 *  after load (which is what the canary loop below does) can start plugins, but it can never give
 *  them a working hijack or a synchronous ncm.getPlaying().  Page.addScriptToEvaluateOnNewDocument
 *  also removes the old "injection does not survive a reload" gap, because the registration lives
 *  in the browser, not in the document.
 *
 *  Registered once per target; re-registering on every tick would stack identical scripts. */
const preloadRegistered = new Set();
const reloadedFor = new Set();
/**
 * The session that owns the document-start registration MUST stay open.
 *
 * Page.addScriptToEvaluateOnNewDocument is scoped to the session that created it: closing the
 * WebSocket removes the registration.  The original implementation opened a session, registered,
 * and closed it again, which silently meant the script never ran on the next document -- measured
 * on the live client as `readyState: "complete", hadJsonp: true, existingLength: 41`, with
 * modulesSeen 0 and applied [].  Keep it alive (the process is a watcher; it lives as long as the
 * session does), and close it only when the target goes away.
 */
let preloadSession = null;
let preloadSessionUrl = null;

async function sessionFor(page) {
  if (preloadSession && preloadSessionUrl === page.webSocketDebuggerUrl) return preloadSession;
  if (preloadSession) { try { preloadSession.close(); } catch { /* ignore */ } }
  const s = new Session(page.webSocketDebuggerUrl);
  await s.open();
  await s.send('Page.enable');
  preloadSession = s;
  preloadSessionUrl = page.webSocketDebuggerUrl;
  return s;
}

function dropSession() {
  if (preloadSession) { try { preloadSession.close(); } catch { /* ignore */ } }
  preloadSession = null;
  preloadSessionUrl = null;
}

async function installPreload(o) {
  const targets = await fetchTargets(o);
  const page = targets.find((t) => t.type === 'page' && (t.url || '').includes(o.match));
  if (!page) throw new Error('no page target');

  const s = await sessionFor(page).catch((e) => { dropSession(); throw e; });

  if (preloadRegistered.has(page.webSocketDebuggerUrl)) {
    // Already registered on this target.  The one case that still needs action: we arrived after
    // the document had executed its chunks, so the rules found nothing.  Reload once.
    if (!reloadedFor.has(page.webSocketDebuggerUrl)) {
      const probe = 'JSON.stringify({canary:!!(window.__BNCM_LOADED__&&window.__BNCM_LOADED__.build),' +
                    'applied:(window.__BNCM_HIJACK__&&window.__BNCM_HIJACK__.applied||[]).length,' +
                    'rules:(window.__BNCM_HIJACK__&&window.__BNCM_HIJACK__.rulesLoaded)||0})';
      try {
        const r = await s.send('Runtime.evaluate', { expression: probe, returnByValue: true });
        const v = r && r.result && r.result.value ? JSON.parse(r.result.value) : null;
        if (v && v.canary && v.rules > 0 && v.applied === 0) {
          reloadedFor.add(page.webSocketDebuggerUrl);
          await s.send('Page.reload', {});
          console.log('no hijack could run in this document (chunks already executed); reloaded once');
        }
      } catch (e) {
        dropSession();
        throw e;
      }
    }
    return;
  }

  const preloadSource = readFileSync(PRELOAD, 'utf8');
  const cfg = { api: o.api || null, key: o.key || '', ncm3Gate: o.ncm3Gate || undefined };
  const source = 'window.__BNCM_CONFIG__ = ' + JSON.stringify(cfg) + ';\n' + preloadSource;

  try {
    await s.send('Page.addScriptToEvaluateOnNewDocument', { source });
    // Also run it now, so an already-open page gets the interceptor and the framework.
    const r = await s.send('Runtime.evaluate', {
      expression: source, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    preloadRegistered.add(page.webSocketDebuggerUrl);
    console.log(`preload registered (${r.result && r.result.value})`);
  } catch (e) {
    dropSession();
    throw e;
  }
}

async function captureScreenshot(path, o) {
  const { Session, fetchTargets } = await import('./cdp_inject.mjs').then(() => ({
    Session: null, fetchTargets: null,
  })).catch(() => ({}));
  // Implemented inline to keep cdp_inject.mjs focused on evaluation.
  const res = await fetch(`http://${o.host}:${o.port}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page' && (t.url || '').includes(o.match));
  if (!page) throw new Error('no page target for screenshot');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  });
  await new Promise((res2, rej) => {
    ws.addEventListener('open', res2);
    ws.addEventListener('error', () => rej(new Error('ws error')));
  });
  const send = (method, params = {}) => new Promise((res2, rej) => {
    const i = ++id; pending.set(i, { resolve: res2, reject: rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Page.enable');
  // Page.captureScreenshot can block indefinitely on a hidden/zero-viewport CEF surface, so
  // race it against a timer instead of hanging the whole tool.
  const shot = await Promise.race([
    send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Page.captureScreenshot timed out')), 15000)),
  ]);
  ws.close();
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), Buffer.from(shot.data, 'base64'));
  return resolve(path);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('cdp_watch.mjs [--port N] [--interval S] [--duration S] [--once] [--api URL] [--key HEX] [--shot file.png]');
    return 0;
  }

  const source = buildInjection(o, readFileSync(o.framework, 'utf8'));
  const started = Date.now();
  let injected = 0;

  const tick = async () => {
    try {
      // Document-start bootstrap first: it installs the webpack interceptor and pulls the
      // framework in itself.  The canary check below then covers the case where the preload
      // could not be registered (older client, or a target that rejects the CDP call).
      await installPreload(o);

      // --force re-injects even when the canary is present, so an edited framework.js takes
      // effect without restarting the client.  The framework is idempotent.
      const alive = o.force ? { value: false } : await evaluate(CANARY, o);
      if (alive.value) {
        if (!o.quiet) console.log(`[${new Date().toLocaleTimeString()}] framework present`);
      } else {
        const r = await evaluate(source, o);
        injected++;
        console.log(`[${new Date().toLocaleTimeString()}] injected -> ${r.value}`);
        o.force = false;   // only the first pass is forced
      }
    } catch (err) {
      if (!o.quiet) console.log(`[${new Date().toLocaleTimeString()}] waiting: ${err.message.split('\n')[0]}`);
    }
  };

  if (o.shot) {
    const p = await captureScreenshot(o.shot, o);
    console.log(`screenshot: ${p}`);
  }

  await tick();
  if (o.once) {
    console.log(`done (injected ${injected} time(s))`);
    return 0;
  }

  console.log(`watching ${o.match} every ${o.interval}s` + (o.duration ? ` for ${o.duration}s` : '') + ' ...');
  return await new Promise((done) => {
    const timer = setInterval(async () => {
      await tick();
      if (o.duration && Date.now() - started >= o.duration * 1000) {
        clearInterval(timer);
        console.log(`stopped (injected ${injected} time(s))`);
        done(0);
      }
    }, o.interval * 1000);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
}
