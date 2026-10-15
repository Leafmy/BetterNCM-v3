#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_market.py -- build (or verify) the bundled BetterNCM plugin market source.

`market/` is not a hand-written catalogue of files; it is DETERMINISTICALLY derived from two
inputs that already live in this repository:

    market/catalog.json     the review metadata that cannot be read off a plugin: preview,
                            upstream repo, licence, publish/update timestamps, stars, notes
    plugins/<name>.plugin   the plugin archives that ship with the repository

Everything else in the index (name/version/author/description/type/requirements/loadAfter/
betterncm_version/ncm-version-req) is read OUT OF THE PLUGIN ARCHIVE ITSELF, so the index can
never claim a version the archive does not contain.  That is the check that matters: a market
whose listing disagrees with the package it hands out is worse than no market at all.

Outputs:

    market/plugins.json     the index: a top-level ARRAY, byte-compatible with the upstream
                            BetterNCM market contract (name/author/version/slug/file/file-url/
                            preview/…), plus additive fields (sha256/size/license/bundled/notes)
                            that upstream consumers ignore
    market/plugins/*.plugin the package store, named `<slug>-<version>.plugin`
    market/market.json      source metadata for our own UI (schema, counts, field list)

Usage:
    py tools/market/build_market.py            # rebuild market/ from the catalogue
    py tools/market/build_market.py --check     # verify market/ is current; non-zero if stale
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
MARKET = os.path.join(REPO, "market")
CATALOG = os.path.join(MARKET, "catalog.json")
PLUGIN_SRC = os.path.join(REPO, "plugins")
STORE = os.path.join(MARKET, "plugins")

INDEX_FIELDS = [
    "name", "author", "version", "description", "slug", "type", "ncm3-compatible",
    "betterncm_version", "ncm-version-req", "preview", "repo", "author_links", "license",
    "publish_time", "update_time", "stars", "file", "file-url", "sha256", "size",
    "requirements", "loadAfter", "incompatible", "bundled", "notes",
]


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_manifest(archive: str) -> dict:
    with zipfile.ZipFile(archive) as zf:
        names = zf.namelist()
        if "manifest.json" not in names:
            raise SystemExit(f"error: {archive} has no manifest.json at its root ({names[:5]})")
        return json.loads(zf.read("manifest.json").decode("utf-8"))


def build(catalog: dict, check: bool) -> int:
    problems: list = []
    entries: list = []
    seen = set()
    known_slugs = {p["slug"] for p in catalog["plugins"]}

    for item in catalog["plugins"]:
        slug = item["slug"]
        if slug in seen:
            problems.append(f"catalog lists slug {slug!r} twice")
            continue
        seen.add(slug)

        src = os.path.join(PLUGIN_SRC, item["plugin"])
        if not os.path.exists(src):
            problems.append(f"{slug}: source archive not found: {item['plugin']}")
            continue

        try:
            manifest = read_manifest(src)
        except SystemExit as exc:
            problems.append(str(exc))
            continue

        if manifest.get("slug") != slug:
            problems.append(f"{slug}: archive manifest.slug is {manifest.get('slug')!r}")
            continue
        for required in ("name", "version", "author"):
            if not manifest.get(required):
                problems.append(f"{slug}: archive manifest has no {required!r}")
        if manifest.get("manifest_version") != 1:
            problems.append(f"{slug}: manifest_version must be 1")

        preview = os.path.join(MARKET, item["preview"].replace("/", os.sep))
        if not os.path.exists(preview):
            problems.append(f"{slug}: preview image missing: {item['preview']}")
        if len(preview) and not item["preview"].startswith("previews/"):
            problems.append(f"{slug}: preview should live under previews/ (got {item['preview']!r})")

        for dep_key in ("requirements", "loadAfter"):
            for dep in manifest.get(dep_key) or []:
                if dep not in known_slugs:
                    problems.append(f"{slug}: {dep_key} names {dep!r}, which this market does not list")

        filename = f"{slug}-{manifest['version']}.plugin"
        target = os.path.join(STORE, filename)
        if not check:
            os.makedirs(STORE, exist_ok=True)
            shutil.copyfile(src, target)
        if not os.path.exists(target):
            problems.append(f"{slug}: store package missing (run without --check): {filename}")
            continue

        digest = sha256_of(target)
        size = os.path.getsize(target)
        if check and digest != sha256_of(src) and os.path.getsize(src) != size:
            problems.append(f"{slug}: store package differs from plugins/{item['plugin']}")

        entries.append({
            "name": manifest["name"],
            "author": manifest["author"],
            "version": manifest["version"],
            "description": manifest.get("description", ""),
            "slug": slug,
            "type": manifest.get("type", "extension"),
            "ncm3-compatible": bool(manifest.get("ncm3-compatible", False)),
            "betterncm_version": manifest.get("betterncm_version", ""),
            "ncm-version-req": manifest.get("ncm-version-req", ""),
            "preview": item["preview"],
            "repo": item.get("repo", ""),
            "author_links": item.get("author_links", []),
            "license": item.get("license", ""),
            "publish_time": int(item.get("publish_time", 0)),
            "update_time": int(item.get("update_time", 0)),
            "stars": int(item.get("stars", 0)),
            "file": filename,
            "file-url": f"plugins/{filename}",
            "sha256": digest,
            "size": size,
            "requirements": list(manifest.get("requirements") or []),
            "loadAfter": list(manifest.get("loadAfter") or []),
            "incompatible": list(manifest.get("incompatible") or []),
            "bundled": bool(item.get("bundled", True)),
            "notes": item.get("notes", ""),
        })

    index_text = json.dumps(entries, ensure_ascii=False, indent=2) + "\n"
    meta = {
        "schema": catalog["schema"],
        "name": catalog["name"],
        "plugin_count": len(entries),
        "bundled_count": sum(1 for e in entries if e["bundled"]),
        "index": "plugins.json",
        "store": "plugins/",
        "previews": "previews/",
        "contract": "top-level array; upstream BetterNCM market fields plus additive ones",
        "fields": INDEX_FIELDS,
    }
    meta_text = json.dumps(meta, ensure_ascii=False, indent=2) + "\n"

    index_path = os.path.join(MARKET, "plugins.json")
    meta_path = os.path.join(MARKET, "market.json")

    if check:
        current = None
        if os.path.exists(index_path):
            with open(index_path, "r", encoding="utf-8") as fh:
                current = fh.read()
        if current != index_text:
            problems.append("market/plugins.json is stale -- run: py tools/market/build_market.py")
        current_meta = None
        if os.path.exists(meta_path):
            with open(meta_path, "r", encoding="utf-8") as fh:
                current_meta = fh.read()
        if current_meta != meta_text:
            problems.append("market/market.json is stale -- run: py tools/market/build_market.py")
        stale = set()
        if os.path.isdir(STORE):
            stale = {n for n in os.listdir(STORE) if n.endswith(".plugin")}
            stale -= {e["file"] for e in entries}
        if stale:
            problems.append(f"market/plugins/ holds packages this catalogue no longer names: {sorted(stale)}")
    else:
        os.makedirs(MARKET, exist_ok=True)
        with open(index_path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(index_text)
        with open(meta_path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(meta_text)
        if os.path.isdir(STORE):
            keep = {e["file"] for e in entries}
            for name in os.listdir(STORE):
                if name.endswith(".plugin") and name not in keep:
                    os.remove(os.path.join(STORE, name))

    for p in problems:
        print(f"  ! {p}", file=sys.stderr)
    if problems:
        return 1

    verb = "verified" if check else "built"
    print(f"{verb} market: {len(entries)} plugin(s), "
          f"{sum(e['size'] for e in entries):,} bytes in market/plugins/")
    for e in entries:
        print(f"  {e['slug']:22s} {e['version']:9s} {e['file']:34s} {e['sha256'][:12]}  "
              f"{'bundled' if e['bundled'] else 'remote'}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="build or verify market/ from market/catalog.json")
    ap.add_argument("--check", action="store_true", help="verify only; non-zero when stale")
    args = ap.parse_args(argv)

    if not os.path.exists(CATALOG):
        print(f"error: {CATALOG} not found", file=sys.stderr)
        return 1
    with open(CATALOG, "r", encoding="utf-8") as fh:
        catalog = json.load(fh)
    return build(catalog, args.check)


if __name__ == "__main__":
    sys.exit(main())
