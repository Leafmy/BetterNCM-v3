#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ncm_probe.py -- probe a NetEase Cloud Music installation and capture a restore baseline.

Two jobs:

  probe     describe the installed client: version, CEF version, package files (run through
            ntpk.py so the container family and signature state are reported), process
            model, and which DLL-proxy targets are importable and not KnownDLLs.

  baseline  hash every stable file in the install directory into a JSON snapshot, excluding
            paths the client rewrites while running.  loader\\uninstall.ps1 and
            test\\restore-verify.ps1 both consume this snapshot to prove a clean restore.

Both modes are read-only.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import struct
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ntpk  # noqa: E402

DEFAULT_INSTALL = r"E:\CloudMusic"
DEFAULT_USERDATA = os.path.join(
    os.environ.get("LOCALAPPDATA", ""), "Netease", "CloudMusic")

# Directories the client creates/churns at runtime.  Never part of a restore comparison.
EXCLUDED_DIRS = [
    "Cache", "Log", "logs", "update", "Temp", "dumps",
    "webapp91x64", "webdata", "ad", "__pycache__",
]
# Root-level files the client rewrites or holds open while running.
EXCLUDED_FILES = [
    "debug.log", "cloudmusic.elog", "localdata", "info", "isc_chat.dat",
]


# --------------------------------------------------------------------------- #
# PE helpers
# --------------------------------------------------------------------------- #

def _pe_dirs(data: bytes):
    e = struct.unpack("<I", data[0x3C:0x40])[0]
    coff = e + 4
    nsec = struct.unpack("<H", data[coff + 2:coff + 4])[0]
    optsz = struct.unpack("<H", data[coff + 16:coff + 18])[0]
    opt = e + 24
    magic = struct.unpack("<H", data[opt:opt + 2])[0]
    dd = opt + (0x70 if magic == 0x20B else 0x60)
    secs = []
    s = coff + 20 + optsz
    for i in range(nsec):
        o = s + i * 40
        vs, va, rs, ra = struct.unpack("<IIII", data[o + 8:o + 24])
        secs.append((va, vs, ra, rs))

    def r2o(rva):
        for va, vs, ra, rs in secs:
            if va <= rva < va + max(vs, rs):
                return ra + (rva - va)
        return None

    def cstr(off):
        if off is None:
            return "?"
        end = data.find(b"\x00", off)
        if end < 0:
            return "?"
        return data[off:end].decode("latin1", "replace")

    return dd, r2o, cstr


def pe_imports(path: str) -> dict:
    """Return {'static': [...], 'delay': [...]} module names."""
    with open(path, "rb") as fh:
        data = fh.read()
    dd, r2o, cstr = _pe_dirs(data)

    imp_rva = struct.unpack("<I", data[dd + 8:dd + 12])[0]
    delay_rva = struct.unpack("<I", data[dd + 13 * 8:dd + 13 * 8 + 4])[0]

    static = []
    off = r2o(imp_rva) if imp_rva else None
    if off is not None:
        while data[off:off + 20] != b"\x00" * 20:
            _oft, _ts, _fwd, nr, _ft = struct.unpack("<IIIII", data[off:off + 20])
            static.append(cstr(r2o(nr)))
            off += 20

    delay = []
    off = r2o(delay_rva) if delay_rva else None
    if off is not None:
        while data[off:off + 32] != b"\x00" * 32:
            vals = struct.unpack("<IIIIIIII", data[off:off + 32])
            delay.append(cstr(r2o(vals[1])))
            off += 32
            if len(delay) > 64:
                break
    return {"static": sorted(set(static)), "delay": sorted(set(delay))}


def pe_version(path: str) -> dict:
    """Read the VS_FIXEDFILEINFO version from a PE. Stdlib only."""
    import ctypes
    from ctypes import wintypes
    ver = ctypes.WinDLL("version")
    size = ver.GetFileVersionInfoSizeW(path, None)
    if not size:
        return {}
    buf = ctypes.create_string_buffer(size)
    if not ver.GetFileVersionInfoW(path, 0, size, buf):
        return {}
    out = ctypes.c_void_p()
    length = wintypes.UINT()
    if not ver.VerQueryValueW(buf, "\\", ctypes.byref(out), ctypes.byref(length)):
        return {}

    class FixedFileInfo(ctypes.Structure):
        _fields_ = [("dwSignature", wintypes.DWORD), ("dwStrucVersion", wintypes.DWORD),
                    ("dwFileVersionMS", wintypes.DWORD), ("dwFileVersionLS", wintypes.DWORD),
                    ("dwProductVersionMS", wintypes.DWORD), ("dwProductVersionLS", wintypes.DWORD)]

    ffi = ctypes.cast(out, ctypes.POINTER(FixedFileInfo)).contents
    fmt = lambda ms, ls: "%d.%d.%d.%d" % (
        ms >> 16, ms & 0xFFFF, ls >> 16, ls & 0xFFFF)
    return {"file_version": fmt(ffi.dwFileVersionMS, ffi.dwFileVersionLS),
            "product_version": fmt(ffi.dwProductVersionMS, ffi.dwProductVersionLS)}


def known_dlls() -> set:
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                             r"SYSTEM\CurrentControlSet\Control\Session Manager\KnownDLLs")
        names = set()
        i = 0
        while True:
            try:
                _n, v, _t = winreg.EnumValue(key, i)
            except OSError:
                break
            names.add(v.lower())
            i += 1
        return names
    except OSError:
        return set()


# --------------------------------------------------------------------------- #
# probe
# --------------------------------------------------------------------------- #

def probe(install: str, userdata: str) -> int:
    exe = os.path.join(install, "cloudmusic.exe")
    dll = os.path.join(install, "cloudmusic.dll")
    cef = os.path.join(install, "libcef.dll")
    if not os.path.exists(exe):
        print(f"error: {exe} not found -- is the client installed at {install}?")
        return 1

    print("=" * 72)
    print("client")
    print("=" * 72)
    print(f"  install dir : {install}")
    print(f"  userdata    : {userdata}")
    try:
        ff = pe_version(exe).get("file_version", "?")
        # VS_FIXEDFILEINFO splits the build across two fields; NetEase's market name
        # ("3.1.41.205529") combines them as major*65536 + minor.  BetterNCM's
        # getNCMExecutableVersion() uses only the leading three components -> "3.1.41".
        print(f"  version     : {ff}   (FIXEDFILEINFO; market name 3.1.41.205529)")
    except OSError as exc:
        print(f"  version     : <unreadable: {exc}>")
    if os.path.exists(cef):
        print(f"  CEF         : {pe_version(cef).get('file_version', '?')}")

    print()
    print("=" * 72)
    print("resource packs")
    print("=" * 72)
    packs = [(os.path.join(install, "package", n)) for n in
             ("orpheus.ntpk", "native.ntpk", "common.skin", "dark.skin")]
    packs.append(os.path.join(userdata, "web.pack"))
    for p in packs:
        if not os.path.exists(p):
            print(f"  {p}: <absent>")
            continue
        info = ntpk.parse(p)
        sig = info.get("signature_check", {})
        extra = ""
        if sig:
            extra = f" sig={'OK' if sig['verified'] else 'BAD'} ({sig.get('key_bits')}b)"
        print(f"  {os.path.basename(p):<14} {info['family']:<7} "
              f"{info['size']:>12,} B  entries={info.get('entry_count', '?'):<5} "
              f"commit={info.get('pub/COMMITHASH', '-'):<8}{extra}")

    print()
    print("=" * 72)
    print("DLL proxy candidates (who imports what; KnownDLLs cannot be hijacked)")
    print("=" * 72)
    kd = known_dlls()
    for host in ("cloudmusic.exe", "cloudmusic.dll", "cloudmusic_util.exe"):
        hp = os.path.join(install, host)
        if not os.path.exists(hp):
            continue
        imp = pe_imports(hp)
        print(f"  {host}:")
        for target in ("msimg32.dll", "version.dll", "winmm.dll", "dbghelp.dll"):
            where = []
            if any(target.lower() == x.lower() for x in imp["static"]):
                where.append("static")
            if any(target.lower() == x.lower() for x in imp["delay"]):
                where.append("delay")
            if not where:
                continue
            verdict = "KNOWN-DLL (unusable)" if target.lower() in kd else "usable"
            print(f"      {target:<14} imported ({'+'.join(where)})  -> {verdict}")

    print()
    print("=" * 72)
    print("process model")
    print("=" * 72)
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-CimInstance Win32_Process -Filter \"Name='cloudmusic.exe'\" | "
             "ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }"],
            capture_output=True, text=True, timeout=60).stdout
    except (OSError, subprocess.SubprocessError) as exc:
        out = ""
        print(f"  <could not query processes: {exc}>")
    if not out.strip():
        print("  client is not running")
    else:
        for line in out.splitlines():
            if not line.strip():
                continue
            pid, _, cmd = line.partition("|")
            tag = "Main"
            if "--type=renderer" in cmd:
                tag = "Renderer"
            elif "--type=gpu-process" in cmd:
                tag = "GpuProcess"
            elif "--type=utility" in cmd:
                tag = "Utility"
            print(f"  pid {pid.strip():<7} {tag}")
        if "--type=renderer" in out:
            print("  -> multi-process CEF: the renderer branch BetterNCM needs IS present")
        else:
            print("  -> WARNING: no --type=renderer child; injection would silently fail")
    return 0


# --------------------------------------------------------------------------- #
# baseline
# --------------------------------------------------------------------------- #

def sha256(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def capture_tree(root: str, excluded_dirs, excluded_files) -> dict:
    out = {}
    for base, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs
                   if os.path.relpath(os.path.join(base, d), root).replace("\\", "/")
                   not in excluded_dirs]
        for n in names:
            p = os.path.join(base, n)
            rel = os.path.relpath(p, root).replace("\\", "/")
            if rel in excluded_files:
                continue
            try:
                out[rel] = {"sha256": sha256(p), "size": os.path.getsize(p)}
            except OSError as exc:
                out[rel] = {"error": str(exc)}
    return out


def baseline(install: str, userdata: str, out_path: str) -> int:
    import sys as _sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    install_files = capture_tree(install, EXCLUDED_DIRS, EXCLUDED_FILES)

    # Only stable, relevant userdata artifacts: the rest is live cache.
    stable_userdata = {}
    for rel in ("web.pack", "Library/webdb.dat", "Library/library.dat",
                "Library/library_bak.dat", "safemode/config"):
        p = os.path.join(userdata, rel.replace("/", os.sep))
        if os.path.exists(p):
            try:
                stable_userdata[rel] = {"sha256": sha256(p), "size": os.path.getsize(p)}
            except OSError as exc:
                stable_userdata[rel] = {"error": str(exc)}

    snap = {
        "captured_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "captured_by": "tools/ncm_probe.py",
        "client_version": pe_version(os.path.join(install, "cloudmusic.exe")).get("file_version"),
        "install_dir": install,
        "userdata_dir": userdata,
        "excluded_relative_dirs": EXCLUDED_DIRS,
        "excluded_relative_files": EXCLUDED_FILES,
        "install": install_files,
        "userdata_stable": stable_userdata,
    }
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(snap, fh, indent=1, ensure_ascii=False)

    errors = [k for k, v in install_files.items() if "error" in v]
    print(f"client version : {snap['client_version']}")
    print(f"install files  : {len(install_files)}")
    print(f"install bytes  : {sum(v.get('size', 0) for v in install_files.values()):,}")
    print(f"userdata stable: {len(stable_userdata)}")
    print(f"excluded dirs  : {', '.join(EXCLUDED_DIRS)}")
    print(f"excluded files : {', '.join(EXCLUDED_FILES)}")
    print(f"unreadable     : {len(errors)}" + (f" {errors[:5]}" if errors else ""))
    print(f"written        : {out_path}")
    return 0


# --------------------------------------------------------------------------- #

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("mode", choices=["probe", "baseline"])
    ap.add_argument("--install", default=DEFAULT_INSTALL)
    ap.add_argument("--userdata", default=DEFAULT_USERDATA)
    ap.add_argument("--out", default=os.path.join("test", "baseline", "hashes.json"))
    args = ap.parse_args(argv)

    if args.mode == "probe":
        return probe(args.install, args.userdata)
    return baseline(args.install, args.userdata, args.out)


if __name__ == "__main__":
    sys.exit(main())
