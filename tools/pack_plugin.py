#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""pack_plugin.py -- package a BetterNCM plugin directory into a `.plugin` archive.

BetterNCM distributes plugins as a ZIP whose root contains `manifest.json` plus the plugin's
files, named `<name>.plugin`.  This tool builds that archive and validates the manifest the
same way the loader does, so a packaging mistake fails here rather than silently inside the
client.

Usage:
    py tools/pack_plugin.py plugins/src/BNCM-SelfTest -o plugins
    py tools/pack_plugin.py plugins/src/* -o plugins
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import zipfile

REQUIRED = ("manifest_version", "name", "version", "author")


def slugify(name: str) -> str:
    out = []
    for ch in name:
        out.append(ch if ch.isalnum() else "-")
    s = "".join(out).strip("-").lower()
    while "--" in s:
        s = s.replace("--", "-")
    return s or "plugin"


def validate(manifest: dict, where: str) -> list:
    problems = []
    for key in REQUIRED:
        if key not in manifest:
            problems.append(f"missing required field '{key}'")
    if manifest.get("manifest_version") != 1:
        problems.append(f"manifest_version must be 1, got {manifest.get('manifest_version')!r}")
    injects = manifest.get("injects")
    if injects is not None and not isinstance(injects, dict):
        problems.append("'injects' must be an object")
    if problems:
        for p in problems:
            print(f"  ! {where}: {p}", file=sys.stderr)
    return problems


def pack(src: str, out_dir: str) -> int:
    manifest_path = os.path.join(src, "manifest.json")
    if not os.path.exists(manifest_path):
        print(f"error: {manifest_path} not found", file=sys.stderr)
        return 1

    with open(manifest_path, "r", encoding="utf-8") as fh:
        manifest = json.load(fh)
    if validate(manifest, src):
        return 1

    slug = manifest.get("slug") or slugify(manifest["name"])
    os.makedirs(out_dir, exist_ok=True)
    target = os.path.join(out_dir, f"{slug}.plugin")
    if os.path.exists(target):
        os.remove(target)

    files = []
    for base, dirs, names in os.walk(src):
        dirs[:] = [d for d in dirs if d not in ("__pycache__", ".git")]
        for n in sorted(names):
            if n.endswith(".pyc"):
                continue
            full = os.path.join(base, n)
            rel = os.path.relpath(full, src).replace(os.sep, "/")
            files.append((rel, full))
    # manifest.json first, as upstream packages it.
    files.sort(key=lambda p: (p[0] != "manifest.json", p[0]))

    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel, full in files:
            zf.write(full, rel)

    size = os.path.getsize(target)
    print(f"packed {slug}.plugin  ({len(files)} files, {size:,} bytes)")
    print(f"  name        : {manifest.get('name')}")
    print(f"  version     : {manifest.get('version')}")
    print(f"  ncm3-compat : {manifest.get('ncm3-compatible')}")
    print(f"  ncm-version : {manifest.get('ncm-version-req', '> 2.10.2 (default)')}")
    print(f"  injects     : {json.dumps(manifest.get('injects', {}))}")
    print(f"  -> {os.path.abspath(target)}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("src", nargs="+", help="plugin source directory/directories")
    ap.add_argument("--out", "-o", default="plugins", help="output directory (default: plugins)")
    args = ap.parse_args(argv)

    rc = 0
    for src in args.src:
        if not os.path.isdir(src):
            print(f"error: {src} is not a directory", file=sys.stderr)
            rc = 1
            continue
        rc |= pack(src, args.out)
    return rc


if __name__ == "__main__":
    sys.exit(main())
