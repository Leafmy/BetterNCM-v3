#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""analyze_bundle.py -- inventory the NetEase Cloud Music 3.x JS<->native bridge.

The Orpheus web layer talks to the C++ host through `window.channel`:

    channel.call(command, callback, args)   -> one-shot request
    channel.registerCall(event, callback)   -> host pushes events back to the page

and through the higher-level helper `window.dbg.Command` (module 118 of the
webpack build), whose `exec()` keeps an explicit whitelist of commands whose
numeric arguments must NOT be coerced to strings.

This tool scans every script in a resource pack, collects every command/event
string literal that looks like `namespace.something`, and emits a JSON
inventory plus a short summary.  It is read-only.
"""

from __future__ import annotations

import argparse
import collections
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ntpk  # noqa: E402

# Command namespaces observed in the 3.1.41 build and in the reimplementation
# published by YUCLing/open-orpheus.
NAMESPACES = (
    "app", "winhelper", "player", "storage", "musiclibrary", "os", "trayicon",
    "browser", "network", "download", "process", "update", "rtc", "audioeffect",
    "desktop", "aegis", "localmusic", "ncm", "sync", "websdk", "customskin",
)

_STR = re.compile(r"""(['"])((?:\\.|(?!\1)[^\\]){2,80})\1""")
_CMD = re.compile(r"^(%s)\.([A-Za-z][A-Za-z0-9_]*)$" % "|".join(NAMESPACES))
# window.dbg.Command.exec() exception list -- numeric args that stay numeric.
_WHITELIST = re.compile(r'\[((?:"[^"]{3,60}"\s*,\s*){5,}"[^"]{3,60}")\]')


def load_scripts(path: str):
    """Yield (member_name, text) for every text asset in a container."""
    zf, family = ntpk._open_zip(path)
    with zf:
        for name in zf.namelist():
            if not name.endswith((".js", ".html", ".json")):
                continue
            if name.endswith(".map"):
                continue
            try:
                raw = zf.read(name)
            except RuntimeError:
                continue          # encrypted, no password
            except KeyError:
                continue
            yield family, name, raw.decode("utf-8", "replace")


def analyze(path: str) -> dict:
    commands = collections.defaultdict(lambda: {"files": set(), "count": 0})
    events = collections.defaultdict(lambda: {"files": set(), "count": 0})
    namespaces = collections.Counter()
    whitelist = None
    runtime_uses = collections.Counter()
    family = None
    n_scripts = 0

    for fam, name, text in load_scripts(path):
        family = fam
        n_scripts += 1
        for m in _STR.finditer(text):
            s = m.group(2)
            hit = _CMD.match(s)
            if not hit:
                continue
            ns, method = hit.group(1), hit.group(2)
            namespaces[ns] += 1
            if method.startswith("on") and len(method) > 2 and method[2].isupper():
                events[ns + "." + method]["files"].add(name)
                events[ns + "." + method]["count"] += 1
            else:
                commands[ns + "." + method]["files"].add(name)
                commands[ns + "." + method]["count"] += 1
        # detect the exec() coercion whitelist
        for m in _WHITELIST.finditer(text):
            names = re.findall(r'"([^"]+)"', m.group(1))
            if any(n.startswith("winhelper.") or n.startswith("player.") for n in names):
                whitelist = names
        # basic call-site census
        for pat, key in ((r"registerCall\s*\(", "registerCall"),
                         (r"\.viewCall\s*\(", "viewCall"),
                         (r"dbg\.Command", "dbg.Command"),
                         (r"\.exec\s*\(", "exec")):
            runtime_uses[key] += len(re.findall(pat, text))

    def dump(d):
        return {
            k: {"files": sorted(v["files"]), "count": v["count"]}
            for k, v in sorted(d.items())
        }

    return {
        "source": os.path.abspath(path),
        "family": family,
        "scripts_scanned": n_scripts,
        "namespace_hits": dict(namespaces.most_common()),
        "commands": dump(commands),
        "events": dump(events),
        "exec_numeric_arg_whitelist": whitelist,
        "call_site_census": dict(runtime_uses),
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("file", help="container to analyse (orpheus.ntpk / web.pack)")
    ap.add_argument("--out", "-o", help="write JSON here")
    ap.add_argument("--top", type=int, default=0, help="list this many commands")
    args = ap.parse_args(argv)

    res = analyze(args.file)
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(res, fh, indent=1, ensure_ascii=False)
        print(f"wrote {args.out}")

    print(f"source            : {res['source']}")
    print(f"scripts scanned   : {res['scripts_scanned']}")
    print(f"commands found    : {len(res['commands'])}")
    print(f"events found      : {len(res['events'])}")
    print(f"namespaces        : {res['namespace_hits']}")
    print(f"call-site census  : {res['call_site_census']}")
    wl = res["exec_numeric_arg_whitelist"]
    print(f"exec() whitelist  : {len(wl) if wl else 0} entries")
    if args.top:
        print("\ntop commands by occurrence:")
        for k, v in sorted(res["commands"].items(), key=lambda kv: -kv[1]["count"])[:args.top]:
            print(f"  {v['count']:>4}  {k}")
        print("\nhost -> page events:")
        for k, v in sorted(res["events"].items(), key=lambda kv: -kv[1]["count"]):
            print(f"  {v['count']:>4}  {k}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
