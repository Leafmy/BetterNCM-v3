// cdp_inject.mjs -- evaluate JavaScript in a NetEase Cloud Music page over the Chrome
// DevTools Protocol.
//
// Why this route exists
// ---------------------
// NetEase Cloud Music 3.1.41.205529 still accepts --remote-debugging-port (verified on this
// build: /json/version reports Chrome/91.0.4472.169 and /json/list exposes the target
// "orpheus://orpheus/pub/app.html").  That gives us a code-injection channel into the exact
// page BetterNCM hooks, with no CEF headers, no Detours, and no file placed in the install
// directory.  It complements the in-process version.dll proxy: CDP for JS, the proxy for
// anything that needs to live inside the renderer.
//
// Usage:
//   node tools/cdp_inject.mjs --expr "document.title"
//   node tools/cdp_inject.mjs --expr-file bootstrap.js --json
//   node tools/cdp_inject.mjs --list
//
// Requires Node >= 21 for the global WebSocket.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULTS = {
  port: 9222,
  host: '127.0.0.1',
  match: 'orpheus://orpheus/pub/app.html',
  expr: null,
  exprFile: null,
  list: false,
  json: false,
  timeout: 20000,
};

function parseArgs(argv) {
  const o = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--port': o.port = Number(next()); break;
      case '--host': o.host = next(); break;
      case '--match': o.match = next(); break;
      case '--expr': o.expr = next(); break;
      case '--expr-file': o.exprFile = next(); break;
      case '--timeout': o.timeout = Number(next()); break;
      case '--list': o.list = true; break;
      case '--json': o.json = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  return o;
}

const base = (o) => `http://${o.host}:${o.port}`;

export async function fetchTargets(o) {
  const res = await fetch(`${base(o)}/json/list`);
  if (!res.ok) throw new Error(`/json/list returned HTTP ${res.status}`);
  return res.json();
}

export async function chromeVersion(o) {
  const res = await fetch(`${base(o)}/json/version`);
  if (!res.ok) throw new Error(`/json/version returned HTTP ${res.status}`);
  return res.json();
}

/** Minimal CDP session over a single WebSocket.  Exported so tools/bncm_agent.mjs can use the
 *  full protocol (Page.addScriptToEvaluateOnNewDocument) and not just Runtime.evaluate. */
export class Session {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error(`WebSocket error: ${this.url}`)));
      this.ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
        else p.resolve(msg.result);
      });
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}

export async function evaluate(expression, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const targets = await fetchTargets(o);
  const page = targets.find((t) => t.type === 'page' && (t.url || '').includes(o.match));
  if (!page) {
    const seen = targets.map((t) => `${t.type}:${t.url}`).join('\n  ');
    throw new Error(`no page target matching "${o.match}". targets:\n  ${seen}`);
  }
  const s = new Session(page.webSocketDebuggerUrl);
  await s.open();
  try {
    await s.send('Runtime.enable');
    const r = await s.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page threw: ${d.exception?.description || d.text}`);
    }
    return { target: page.url, value: r.result?.value, description: r.result?.description };
  } finally {
    s.close();
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('cdp_inject.mjs --port N --expr "js" | --expr-file f.js | --list [--json]');
    return 0;
  }

  if (o.list) {
    const targets = await fetchTargets(o);
    if (o.json) { console.log(JSON.stringify(targets, null, 1)); return 0; }
    for (const t of targets) console.log(`${t.type.padEnd(8)} ${t.url}`);
    return 0;
  }

  let expr = o.expr;
  if (o.exprFile) expr = readFileSync(o.exprFile, 'utf8');
  if (!expr) throw new Error('nothing to evaluate: pass --expr or --expr-file');

  const res = await evaluate(expr, o);
  if (o.json) { console.log(JSON.stringify(res, null, 1)); return 0; }
  console.log(`target: ${res.target}`);
  console.log(typeof res.value === 'string' ? res.value : JSON.stringify(res.value));
  return 0;
}

// Only run main() when invoked directly, so other tools can import evaluate().
// pathToFileURL handles the Windows drive-letter form (file:///C:/...) correctly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c)).catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}
