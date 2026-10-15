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
    py tools/pack_plugin.py plugins/src/NCM-Font-Manager -o plugins --runtime-only
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import zipfile

REQUIRED = ("manifest_version", "name", "version", "author")


def runtime_file_set(manifest: dict) -> set:
    """The files an INSTALLED copy actually needs: the manifest plus everything `injects` names.

    A plugin source directory also holds material that must not ship inside the archive -- a
    README, a NOTICE, a licence copy, screenshots.  Upstream's listing rules say the same thing
    ("只保留需要的文件"), and the three redistributed plugins already follow it.  `--runtime-only`
    makes that mechanical instead of a matter of remembering to prune by hand.
    """
    keep = {"manifest.json"}
    injects = manifest.get("injects") or {}
    if isinstance(injects, dict):
        for bucket in injects.values():
            if not isinstance(bucket, list):
                continue
            for entry in bucket:
                if isinstance(entry, dict) and entry.get("file"):
                    keep.add(str(entry["file"]).lstrip("./").replace("\\", "/"))
    return keep


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


def pack(src: str, out_dir: str, runtime_only: bool = False) -> int:
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

    keep = runtime_file_set(manifest) if runtime_only else None
    files = []
    for base, dirs, names in os.walk(src):
        dirs[:] = [d for d in dirs if d not in ("__pycache__", ".git")]
        for n in sorted(names):
            if n.endswith(".pyc"):
                continue
            full = os.path.join(base, n)
            rel = os.path.relpath(full, src).replace(os.sep, "/")
            if keep is not None and rel not in keep:
                continue
            files.append((rel, full))
    missing = sorted((keep or set()) - {rel for rel, _ in files})
    if missing:
        for rel in missing:
            print(f"  ! {src}: manifest names '{rel}' but the source directory has no such file",
                  file=sys.stderr)
        return 1
    # manifest.json first, as upstream packages it.
    files.sort(key=lambda p: (p[0] != "manifest.json", p[0]))

    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel, full in files:
            zf.write(full, rel)

    size = os.path.getsize(target)
    print(f"packed {slug}.plugin  ({len(files)} files, {size:,} bytes)"
          + ("  [runtime-only]" if runtime_only else ""))
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
    ap.add_argument("--runtime-only", action="store_true",
                    help="archive only manifest.json plus the files manifests' injects name")
    args = ap.parse_args(argv)

    rc = 0
    for src in args.src:
        if not os.path.isdir(src):
            print(f"error: {src} is not a directory", file=sys.stderr)
            rc = 1
            continue
        rc |= pack(src, args.out, runtime_only=args.runtime_only)
    return rc


if __name__ == "__main__":
    sys.exit(main())
