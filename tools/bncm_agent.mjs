// bncm_agent.mjs -- keep the BetterNCM loader attached to the NetEase client, unattended.
//
// Why this exists
// ---------------
// The loader needs two things that only exist while the client runs: a backend (tools/ncm_host.mjs)
// and an injection channel.  loader/launch.cmd does both for a development session, but it has to
// be invoked, and the requirement is that plugins load simply because the user opened 网易云音乐.
//
// How it stays unattended
// -----------------------
// CDP is the injection channel (see tools/cdp_inject.mjs for why), and the client only opens the
// DevTools endpoint when it was STARTED with --remote-debugging-port.  We deliberately do not try
// to add that switch after the fact: the client contains a `[boot] protocol command line injection
// detected, blocked.` check (docs/04-antitamper.md §3 #3), and patching the command line at runtime
// is precisely what that check exists to catch.
//
// So the agent controls the START instead of the process:
//   * `--launch`  : the entry point a shortcut points at.  Starts the client with the switch.
//   * `--at-logon`: a watchdog.  Waits for the client to appear; if it appeared WITHOUT the switch,
//                   restarts it once (rate-limited) so the endpoint exists.
// Both modes then start the backend and keep the page injected.
//
// The restart is the one intrusive thing this design does, so it is bounded: at most one per
// RELAUNCH_WINDOW_MS, at most MAX_RELAUNCHES per client start, and every decision is written to
// out/agent.log.  `--no-relaunch` turns it off entirely.
//
// Usage:
//   node tools/bncm_agent.mjs --launch            # start client + host + inject (shortcut target)
//   node tools/bncm_agent.mjs --at-logon          # watchdog (registered by loader\startup.cmd)
//   node tools/bncm_agent.mjs --once              # attach to a running client and inject, then exit
//   node tools/bncm_agent.mjs --status            # report what is up, change nothing
//
// Requires Node >= 21 (global WebSocket).

import { spawnSync, spawn } from 'node:child_process';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, appendFileSync,
} from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluate, fetchTargets, chromeVersion, Session } from './cdp_inject.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const LOCK = join(REPO, 'out', 'agent.lock');
const LOG = join(REPO, 'out', 'agent.log');
const HOST_DESCRIPTOR = join(REPO, 'out', 'host.json');
const PRELOAD = join(REPO, 'tools', 'bncm_preload.js');

const RELAUNCH_WINDOW_MS = 60000;
const MAX_RELAUNCHES = 3;
const CANARY = 'typeof window.__BNCM_LOADED__ === "object" && !!window.__BNCM_LOADED__.build';

function parseArgs(argv) {
  const o = {
    ncm: 'E:\\CloudMusic', port: 9222, host: '127.0.0.1',
    match: 'orpheus://orpheus/pub/app.html',
    data: process.env.BETTERNCM_PROFILE || 'C:\\betterncm',
    // User plugins live in the DATA directory, not in the repo: that is where the user installs
    // and uninstalls them (upstream uses the same location), and the manager moves files in and
    // out of it.  null means "derive from --data" once both are known.
    plugins: null,
    // No built-in plugin directory: the three big plugins are ordinary user plugins now.
  corePlugins: null,
    hostPort: 0,
    interval: 3,
    launch: false, atLogon: false, once: false, status: false,
    noRelaunch: false, quiet: false, duration: 0,
    // Dev mode is normally a loader\launch.cmd thing; forwarded here only so a single session
    // can be started with -Agent and still see the author's dev sources.
    devSources: [], devWatch: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`missing value for ${a}`); return v; };
    switch (a) {
      case '--ncm': o.ncm = next(); break;
      case '--port': o.port = Number(next()); break;
      case '--host': o.host = next(); break;
      case '--match': o.match = next(); break;
      case '--data': o.data = next(); break;
      case '--plugins': o.plugins = next(); break;
      case '--core-plugins': o.corePlugins = next(); break;
      case '--dev-dir': case '--dev-source': o.devSources.push(next()); break;
      case '--dev-watch': o.devWatch = true; break;
      case '--host-port': o.hostPort = Number(next()); break;
      case '--interval': o.interval = Number(next()); break;
      case '--duration': o.duration = Number(next()); break;
      case '--launch': o.launch = true; break;
      case '--at-logon': o.atLogon = true; break;
      case '--once': o.once = true; break;
      case '--status': o.status = true; break;
      case '--no-relaunch': o.noRelaunch = true; break;
      case '--quiet': o.quiet = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  if (!o.launch && !o.atLogon && !o.once && !o.status) o.atLogon = true;
  if (!o.plugins) o.plugins = join(o.data, 'plugins');
  return o;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, line);
  } catch { /* ignore */ }
  if (!process.env.BNCM_QUIET) process.stdout.write(line);
}

/* ------------------------------------------------------------- singleton ---- */

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function acquireLock() {
  try {
    if (existsSync(LOCK)) {
      const prev = JSON.parse(readFileSync(LOCK, 'utf8'));
      if (prev && prev.pid !== process.pid && pidAlive(prev.pid)) {
        log(`another agent is already running (pid ${prev.pid}); exiting`);
        return false;
      }
      log(`replacing a stale agent lock (pid ${prev && prev.pid})`);
    }
  } catch { /* unreadable lock -> treat as stale */ }
  mkdirSync(dirname(LOCK), { recursive: true });
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8');
  return true;
}

function releaseLock() {
  try {
    const cur = JSON.parse(readFileSync(LOCK, 'utf8'));
    if (cur && cur.pid === process.pid) rmSync(LOCK, { force: true });
  } catch { /* ignore */ }
}

/* ----------------------------------------------------------------- backend ---- */

async function hostReachable(api, key) {
  try {
    const r = await fetch(`${api}/api/app/version`, { headers: { 'X-BNCM-Key': key } });
    return r.ok;
  } catch { return false; }
}

async function readDescriptor() {
  try { return JSON.parse(readFileSync(HOST_DESCRIPTOR, 'utf8')); } catch { return null; }
}

/** Start the backend unless a live one is already published in the descriptor. */
async function ensureHost(o) {
  const existing = await readDescriptor();
  if (existing && existing.api && await hostReachable(existing.api, existing.key)) {
    log(`reusing backend ${existing.api}`);
    return existing;
  }
  rmSync(HOST_DESCRIPTOR, { force: true });
  const args = [
    join(REPO, 'tools', 'ncm_host.mjs'),
    '--port', String(o.hostPort), '--descriptor', HOST_DESCRIPTOR,
    '--data', o.data, '--ncm', o.ncm,
    '--plugins', o.plugins,
  ];
  for (const src of o.devSources || []) args.push('--dev-source', src);
  if (o.devWatch) args.push('--dev-watch');
  log(`starting backend: node tools/ncm_host.mjs --data ${o.data}`);
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(300);
    const d = await readDescriptor();
    if (d && d.api && await hostReachable(d.api, d.key)) {
      log(`backend ready: ${d.api} (data=${d.data})`);
      return d;
    }
  }
  throw new Error(`backend did not come up within 20s (see out/host.stdout.log, ${o.data}\\host.log)`);
}

/* ----------------------------------------------------------------- client ---- */

/** Processes named cloudmusic, with their command lines (needs Win32_Process). */
function clientProcesses() {
  if (process.platform !== 'win32') return [];
  const ps = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='cloudmusic.exe'\" | " +
    'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
  ], { encoding: 'utf8', windowsHide: true });
  if (ps.status !== 0 || !ps.stdout || !ps.stdout.trim()) return [];
  let parsed;
  try { parsed = JSON.parse(ps.stdout); } catch { return []; }
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function cdpUp(o) {
  try { await chromeVersion(o); return true; } catch { return false; }
}

function startClient(o, withPort) {
  const exe = join(o.ncm, 'cloudmusic.exe');
  if (!existsSync(exe)) throw new Error(`client not found: ${exe}`);
  const args = withPort ? [`--remote-debugging-port=${o.port}`] : [];
  log(`starting client ${withPort ? '(with debug port)' : '(plain)'}: ${exe} ${args.join(' ')}`);
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return child;
}

function killClients() {
  for (const p of clientProcesses()) {
    try { process.kill(p.ProcessId); } catch { /* ignore */ }
  }
}

/* -------------------------------------------------------------- injection ---- */

/** Does at least one hijack rule actually want to rewrite something?
 *
 *  This decides whether the preload is allowed to interpose on window.webpackJsonp at all.  It is
 *  not a micro-optimisation: interposition itself (the `push` accessor plus the synthetic capture
 *  module) was measured to stop the client from mounting, so with every rule disabled -- the state
 *  documented in docs/11 section 8 -- the preload must stay a plain bootstrap. */
function hijackRulesEnabled() {
  try {
    const book = JSON.parse(readFileSync(join(REPO, 'loader', 'hijacks.json'), 'utf8'));
    const enabled = (book.rules || []).filter((r) => !r.pending && (r.from || r.locate));
    log(`hijack rules enabled: ${enabled.length} of ${(book.rules || []).length}`);
    return enabled.length > 0;
  } catch (e) {
    log(`could not read loader/hijacks.json (${e.message}); disabling interception`);
    return false;
  }
}

function buildInjection(config, preloadSource) {
  return 'window.__BNCM_CONFIG__ = ' + JSON.stringify(config) + ';\n' + preloadSource;
}

/** Register the document-start preload and also evaluate it into the CURRENT document.
 *
 *  Page.addScriptToEvaluateOnNewDocument is what makes a hijack possible at all: the module
 *  factories are registered while the page loads, so an injection that arrives afterwards can
 *  never rewrite them.  It also fixes the older "injection does not survive a reload" gap.
 *
 *  The immediate evaluate keeps the already-open page working on a client that was already
 *  running when the agent attached -- but on that first attach the chunks have ALREADY executed,
 *  so the rules find nothing and __BNCM_HIJACK__.applied stays empty.  We therefore reload the
 *  page ONCE per target, after the preload is registered, so the rules get a chance to run
 *  before the bundle does.  (Learned the hard way: the first live run showed
 *  hooksInstalled=true with applied=[].) */
const preloadRegistered = new Set();
const reloadedFor = new Set();

const HIJACK_PROBE = `JSON.stringify({
  canary: !!(window.__BNCM_LOADED__ && window.__BNCM_LOADED__.build),
  preload: window.__BNCM_PRELOAD__ || null,
  applied: (window.__BNCM_HIJACK__ && window.__BNCM_HIJACK__.applied || []).length,
  rules: (window.__BNCM_HIJACK__ && window.__BNCM_HIJACK__.rulesLoaded) || 0,
  late: !!(window.__BNCM_HIJACK__ && window.__BNCM_HIJACK__.boot && window.__BNCM_HIJACK__.boot.hadJsonp)
})`;

/** The CDP session is kept OPEN for the agent's whole lifetime, on purpose.
 *
 *  Page.addScriptToEvaluateOnNewDocument is scoped to the session that created it: closing the
 *  WebSocket tears the registration down.  The first implementation opened a session per tick
 *  (register + evaluate + close), which meant the document-start script never survived to the next
 *  document -- measured on the live client as `readyState: "complete", hadJsonp: true,
 *  existingLength: 41`, i.e. the preload only ever ran as a late Runtime.evaluate and no module
 *  factory was reachable.  Keeping one session alive is what makes the hijacks possible. */
let cdp = null;                                  // { url, session }

async function cdpSession(page) {
  if (cdp && cdp.url === page.webSocketDebuggerUrl) return cdp.session;
  closeCdp();
  const s = new Session(page.webSocketDebuggerUrl);
  await s.open();
  await s.send('Runtime.enable');
  await s.send('Page.enable');
  cdp = { url: page.webSocketDebuggerUrl, session: s };
  log('cdp session opened and kept open (document-start registration depends on it)');
  return s;
}

function closeCdp() {
  if (!cdp) return;
  try { cdp.session.close(); } catch { /* ignore */ }
  cdp = null;
}

async function attach(o, api, key) {
  const targets = await fetchTargets(o);
  const page = targets.find((t) => t.type === 'page' && (t.url || '').includes(o.match));
  if (!page) {
    const seen = targets.map((t) => `${t.type}:${t.url}`).join(', ');
    throw new Error(`no page target matching "${o.match}" (targets: ${seen})`);
  }
  const preloadSource = readFileSync(PRELOAD, 'utf8');
  o.intercept = hijackRulesEnabled();
  // `intercept` tells the preload whether it may touch webpackJsonp at all; see hijackRulesEnabled.
  const config = { api, key, ncm3Gate: o.ncm3Gate || undefined, intercept: o.intercept };
  const s = await cdpSession(page);

  try {
    let registered = false;
    const alreadyRegistered = preloadRegistered.has(page.webSocketDebuggerUrl);
    if (!alreadyRegistered) {
      const r = await s.send('Page.addScriptToEvaluateOnNewDocument', {
        source: buildInjection(config, preloadSource),
      });
      registered = !!(r && r.identifier);
      preloadRegistered.add(page.webSocketDebuggerUrl);
      log(`document-start preload registered (${registered ? r.identifier : 'no identifier'})`);
    }

    const evalIn = async (expression) => {
      const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result && r.result.value;
    };

    const alive = await s.send('Runtime.evaluate', { expression: CANARY, returnByValue: true, awaitPromise: true });
    let state = null;
    try { state = JSON.parse(await evalIn(HIJACK_PROBE) || '{}'); } catch { state = null; }

    if (!(alive.result && alive.result.value)) {
      const v = await evalIn(buildInjection(config, preloadSource));
      log(`injected into the open page -> ${v}`);
    } else if ((registered || alreadyRegistered) && state && state.rules > 0 && state.applied === 0 &&
               !reloadedFor.has(page.webSocketDebuggerUrl)) {
      // The framework is up but no rule could run: this document had already executed its chunks
      // before the registration existed.  One reload now lets the registered script run first.
      // NOT gated on `registered` alone -- on the very first tick the framework is usually absent,
      // so `registered` is true while the canary is false; by the time the canary is true,
      // `registered` is false and the reload would never happen.
      reloadedFor.add(page.webSocketDebuggerUrl);
      log('framework present but no hijack could run (chunks already executed); reloading once');
      await s.send('Page.reload', { ignoreCache: false });
      return { registered, reloaded: true };
    } else {
      log('framework already present in the open page');
    }
    return { registered, reloaded: false };
  } catch (e) {
    // A dead socket must not poison the cache: drop it so the next tick reopens cleanly.
    if (/WebSocket|Target closed|Session closed|not open/i.test(e.message)) closeCdp();
    throw e;
  }
}

/* --------------------------------------------------------------- rel launch ---- */

function makeRelaunchBudget() {
  return { events: [], countForStart: 0 };
}

function mayRelaunch(budget) {
  const now = Date.now();
  budget.events = budget.events.filter((t) => now - t < RELAUNCH_WINDOW_MS);
  if (budget.events.length >= 1) return { ok: false, why: 'one restart already happened in the last 60s' };
  if (budget.countForStart >= MAX_RELAUNCHES) return { ok: false, why: `already restarted ${MAX_RELAUNCHES}x for this client start` };
  return { ok: true };
}

/* ------------------------------------------------------------------- main ---- */

async function status(o) {
  const up = await cdpUp(o);
  const d = await readDescriptor();
  const host = d && d.api ? await hostReachable(d.api, d.key) : false;
  const procs = clientProcesses();
  const lines = [
    `client processes : ${procs.length}`,
    `debug port ${String(o.port).padEnd(5)}: ${up ? 'reachable' : 'NOT reachable'}`,
    `backend          : ${d ? d.api : '(no descriptor)'} ${host ? 'ok' : 'NOT responding'}`,
    `data dir         : ${(d && d.data) || o.data}`,
    `plugins dir      : ${(d && d.pluginsDir) || o.plugins}`,
    `agent lock       : ${existsSync(LOCK) ? readFileSync(LOCK, 'utf8').trim() : '(none)'}`,
  ];
  console.log(lines.join('\n'));
  return up && host ? 0 : 2;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('bncm_agent.mjs [--launch | --at-logon | --once | --status] [--ncm DIR] [--port N]' +
                ' [--data DIR] [--plugins DIR] [--core-plugins DIR] [--no-relaunch] [--interval S]');
    return 0;
  }
  if (o.status) return status(o);
  if (o.quiet) process.env.BNCM_QUIET = '1';

  if (o.duration > 0) setTimeout(() => { log(`duration ${o.duration}s elapsed; exiting`); process.exit(0); }, o.duration * 1000);

  if (!o.once && !acquireLock()) return 0;
  const budget = makeRelaunchBudget();
  const started = Date.now();

  let host = null;
  try {
    host = await ensureHost(o);
  } catch (e) {
    log(`FATAL ${e.message}`);
    return 1;
  }

  // --once: attach to whatever is running and stop.  No client management at all.
  if (o.once) {
    if (!await cdpUp(o)) {
      log('no debug endpoint; start the client with loader\\launch.cmd or use --launch / --at-logon');
      return 2;
    }
    await attach(o, host.api, host.key);
    return 0;
  }

  if (o.launch) {
    // Shortcut entry point: we own the process start, so the switch is present from birth and
    // no restart is ever needed.
    if (!await cdpUp(o)) {
      const procs = clientProcesses();
      if (procs.length) {
        log('a client is running without the debug port; restarting it once (shortcut mode)');
        killClients();
        await sleep(1800);
      }
      startClient(o, true);
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !await cdpUp(o)) await sleep(500);
    }
  }

  log(`watching ${o.match} every ${o.interval}s (mode=${o.launch ? 'launch' : 'logon'})`);
  let announcedEmpty = false;

  while (true) {
    try {
      const procs = clientProcesses();
      if (!procs.length) {
        if (!announcedEmpty) { log('waiting for the client to start'); announcedEmpty = true; }
        await sleep(1500);
        continue;
      }
      announcedEmpty = false;

      if (!await cdpUp(o)) {
        // The client is up but was not started with the switch.  That is the only case where we
        // become intrusive, and only if the user has not disabled it.
        if (o.noRelaunch) {
          log('client is running without the debug port and --no-relaunch is set; standing by');
          await sleep(5000);
          continue;
        }
        const verdict = mayRelaunch(budget);
        if (!verdict.ok) {
          log(`not restarting the client: ${verdict.why}`);
          await sleep(5000);
          continue;
        }
        log('client is running without the debug port; restarting it once so plugins can load');
        budget.events.push(Date.now());
        budget.countForStart += 1;
        killClients();
        await sleep(1800);
        startClient(o, true);
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline && !await cdpUp(o)) await sleep(500);
        if (!await cdpUp(o)) { log('restarted client still has no debug endpoint; giving up for now'); await sleep(5000); continue; }
      }

      budget.countForStart = 0;                       // a healthy start resets the per-start budget
      await attach(o, host.api, host.key);
      await sleep(o.interval * 1000);
    } catch (e) {
      log(`watch: ${e.message}`);
      await sleep(o.interval * 1000);
    }

    if (o.duration > 0 && Date.now() - started > o.duration * 1000) break;
  }
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then((c) => { releaseLock(); process.exit(c); })
        .catch((e) => { log(`FATAL ${e.stack || e.message}`); releaseLock(); process.exit(1); });
}

export { main };
