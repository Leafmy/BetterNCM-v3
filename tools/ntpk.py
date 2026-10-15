#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ntpk.py -- container tool for NetEase Cloud Music (Orpheus) resource packs.

Two container families are handled.

Family A -- "signed web pack"
    Files: package/orpheus.ntpk, package/web.pack
            100-byte header, then a plain ZIP:

        [  0:  4]  ASCII decimal version marker, e.g. b"0003"  (value 3)
        [  4: 36]  32 bytes of ASCII hex metadata (constant across builds)
        [ 36:100]  64-byte RSA-512 / PKCS#1 v1.5 signature over body = data[100:]
        [100:   ]  ZIP archive

    The ZIP central-directory offsets recorded in the file are relative to the
    body (i.e. relative to a header-less archive).  A reader therefore computes
    the prefix length as

        concat = eocd_pos - cd_size - cd_offset

    which equals 100 here.  Python's zipfile performs that computation itself,
    which is why a plain ZipFile(path) can read these files directly.

    Consequence for repacking: build the ZIP standalone (offsets relative to 0)
    and then prepend a 100-byte header.  The result reproduces the original
    geometry exactly.  The signature cannot be regenerated without the private
    key, so repacked Family A files will fail the client's verification.

Family B -- "NTPK container"
    Files: package/*.skin (common.skin, dark.skin), package/native.ntpk

        [  0:  4]  b"NTPK"
        [  4:  8]  uint32 LE version / flags (0)
        [  8: 12]  uint32 LE payload size  (len(file) - 272)
        [ 12: 16]  uint32 LE header size   (0x100 == 256)
        [ 16:272]  256-byte header blob
        [272:   ]  ZIP archive (individual entries may be ZipCrypto encrypted)

This tool is read-only with respect to the NetEase installation: it never writes
to the source path.  All output goes where the caller asks (default ./out).
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shutil
import struct
import sys
import zipfile

FAMILY_WEB = "web"
FAMILY_NTPK = "ntpk"
FAMILY_UNKNOWN = "unknown"

WEB_HEADER_LEN = 100
NTPK_MAGIC = b"NTPK"
NTPK_HEAD_LEN = 272          # 16 fixed bytes + 256-byte header blob
NTPK_HEADER_BLOB = 0x100     # expected value of the uint32 at offset (== 256)

# RSA-512 SubjectPublicKeyInfo (DER) used to verify Family A signatures.
# Source: YUCLing/open-orpheus, src/main/packs/WebPack.ts (MIT).
WEB_PACK_PUBKEY_DER = bytes.fromhex(
    "305c300d06092a864886f70d0101010500034b003048024100"
    "b057e5f79eaca212f43cc51de0da2349d13b0ac7de87eb52"
    "da23096f0b1594cab08f87ff1a6a05808046a67e359b902f"
    "8982a1ad987a83ae62246dd3b64ee6f50203010001"
)

# DigestInfo DER prefix for SHA-1, used by PKCS#1 v1.5 verification.
_SHA1_DIGESTINFO = bytes.fromhex("3021300906052b0e03021a05000414")


# --------------------------------------------------------------------------- #
# detection
# --------------------------------------------------------------------------- #

def detect(data: bytes) -> str:
    """Return the container family of a buffer."""
    if data[:4] == NTPK_MAGIC:
        return FAMILY_NTPK
    if len(data) > WEB_HEADER_LEN and data[WEB_HEADER_LEN:WEB_HEADER_LEN + 4] == b"PK\x03\x04":
        return FAMILY_WEB
    # Fall back to a bare ZIP (no wrapper) so the tool is still useful.
    if data[:4] == b"PK\x03\x04":
        return "zip"
    return FAMILY_UNKNOWN


def _web_concat(data: bytes) -> int | None:
    """Prefix length implied by the ZIP end-of-central-directory record."""
    eocd = data.rfind(b"PK\x05\x06")
    if eocd < 0 or eocd + 22 > len(data):
        return None
    cd_size, cd_off = struct.unpack("<II", data[eocd + 12:eocd + 20])
    return len(data) - 22 - cd_size - cd_off


# --------------------------------------------------------------------------- #
# ASN.1 / RSA-512 verification (stdlib only)
# --------------------------------------------------------------------------- #

def _der_read(buf: bytes, pos: int) -> tuple[int, bytes, int]:
    """Read one DER TLV. Returns (tag, value, next_pos)."""
    tag = buf[pos]
    pos += 1
    first = buf[pos]
    pos += 1
    if first & 0x80:
        n = first & 0x7F
        length = int.from_bytes(buf[pos:pos + n], "big")
        pos += n
    else:
        length = first
    return tag, buf[pos:pos + length], pos + length


def _rsa_pubkey_from_spki(der: bytes) -> tuple[int, int]:
    """Extract (n, e) from a SubjectPublicKeyInfo containing an RSAPublicKey."""
    _, spki, _ = _der_read(der, 0)                       # SEQUENCE
    _, _alg, p = _der_read(spki, 0)                      # AlgorithmIdentifier
    _, bitstr, _ = _der_read(spki, p)                    # BIT STRING
    if bitstr and bitstr[0] == 0x00:                     # unused-bits octet
        bitstr = bitstr[1:]
    _, rsa, _ = _der_read(bitstr, 0)                     # SEQUENCE { n, e }
    _, n_bytes, p2 = _der_read(rsa, 0)
    _, e_bytes, _ = _der_read(rsa, p2)
    return int.from_bytes(n_bytes, "big"), int.from_bytes(e_bytes, "big")


def verify_web_signature(data: bytes) -> dict:
    """Verify the Family A header signature. Never raises on a bad signature."""
    result = {"verified": False, "reason": None, "version": None,
              "key_bits": None, "hash": "sha1"}
    if len(data) <= WEB_HEADER_LEN:
        result["reason"] = "file too short"
        return result

    marker = data[0:4]
    try:
        version = int(marker.decode("ascii"))
    except (UnicodeDecodeError, ValueError):
        result["reason"] = f"unparsable version marker {marker!r}"
        return result
    result["version"] = version
    if version != 3:
        result["reason"] = f"unexpected container version {version} (expected 3)"
        return result

    n, e = _rsa_pubkey_from_spki(WEB_PACK_PUBKEY_DER)
    result["key_bits"] = n.bit_length()

    signature = data[36:100]
    body = data[WEB_HEADER_LEN:]
    if len(signature) != 64:
        result["reason"] = "signature field is not 64 bytes"
        return result

    m = pow(int.from_bytes(signature, "big"), e, n)
    k = (n.bit_length() + 7) // 8
    em = m.to_bytes(k, "big")

    # Expected EMSA-PKCS1-v1_5: 0x00 || 0x01 || 0xFF..FF || 0x00 || DigestInfo
    if em[0] != 0x00 or em[1] != 0x01:
        result["reason"] = "PKCS#1 v1.5 block prefix mismatch"
        return result
    idx = 2
    while idx < len(em) and em[idx] == 0xFF:
        idx += 1
    if idx < 10 or em[idx] != 0x00:
        result["reason"] = "PKCS#1 v1.5 padding malformed"
        return result
    digest_info = em[idx + 1:]
    if not digest_info.startswith(_SHA1_DIGESTINFO):
        result["reason"] = "DigestInfo is not SHA-1"
        return result

    expected = digest_info[len(_SHA1_DIGESTINFO):]
    actual = hashlib.sha1(body).digest()
    if expected == actual:
        result["verified"] = True
    else:
        result["reason"] = "SHA-1 digest mismatch (payload modified or wrong key)"
    return result


# --------------------------------------------------------------------------- #
# parsing
# --------------------------------------------------------------------------- #

def parse(path: str) -> dict:
    """Describe a container file without writing anything."""
    with open(path, "rb") as fh:
        data = fh.read()
    family = detect(data)

    info = {
        "path": os.path.abspath(path),
        "size": len(data),
        "family": family,
        "sha256": hashlib.sha256(data).hexdigest(),
    }

    if family == FAMILY_WEB:
        body = data[WEB_HEADER_LEN:]
        info["header"] = {
            "version_marker": data[0:4].decode("ascii", "replace"),
            "meta_hex": data[4:36].decode("ascii", "replace"),
            "signature": data[36:100].hex(),
        }
        info["concat"] = _web_concat(data)
        info["signature_check"] = verify_web_signature(data)
        zf_source = io.BytesIO(body)
    elif family == FAMILY_NTPK:
        blob = struct.unpack("<I", data[12:16])[0]
        info["header"] = {
            "version": struct.unpack("<I", data[4:8])[0],
            "payload_size": struct.unpack("<I", data[8:12])[0],
            "header_blob_size": blob,
            "header_blob": data[16:16 + min(blob, 256)].hex(),
            "payload_size_matches": struct.unpack("<I", data[8:12])[0] == len(data) - NTPK_HEAD_LEN,
        }
        zf_source = io.BytesIO(data[NTPK_HEAD_LEN:])
    elif family == "zip":
        zf_source = io.BytesIO(data)
    else:
        info["error"] = "unrecognised container (no NTPK magic, no PK header)"
        return info

    entries = []
    encrypted = 0
    try:
        with zipfile.ZipFile(zf_source) as zf:
            for zi in zf.infolist():
                enc = bool(zi.flag_bits & 0x1)
                if enc:
                    encrypted += 1
                entries.append({
                    "name": zi.filename,
                    "size": zi.file_size,
                    "compressed": zi.compress_size,
                    "method": zi.compress_type,
                    "encrypted": enc,
                })
    except zipfile.BadZipFile as exc:
        info["error"] = f"payload is not a readable ZIP: {exc}"
        return info

    info["entry_count"] = len(entries)
    info["encrypted_entries"] = encrypted
    info["entries"] = entries

    for probe in ("pub/COMMITHASH", "pub/VERSION"):
        try:
            with zipfile.ZipFile(zf_source) as zf:
                info[probe] = zf.read(probe).decode("utf-8", "replace").strip()
        except (KeyError, zipfile.BadZipFile, RuntimeError):
            pass
    return info


def _open_zip(path: str):
    """Open the ZIP payload of a container, returning (ZipFile, family)."""
    with open(path, "rb") as fh:
        data = fh.read()
    family = detect(data)
    if family == FAMILY_WEB:
        return zipfile.ZipFile(io.BytesIO(data[WEB_HEADER_LEN:])), family
    if family == FAMILY_NTPK:
        return zipfile.ZipFile(io.BytesIO(data[NTPK_HEAD_LEN:])), family
    if family == "zip":
        return zipfile.ZipFile(path), family
    raise SystemExit(f"error: {path}: unrecognised container format")


# --------------------------------------------------------------------------- #
# commands
# --------------------------------------------------------------------------- #

def cmd_info(args) -> int:
    info = parse(args.file)
    if args.json:
        print(json.dumps(info, indent=2, ensure_ascii=False))
        return 0

    print(f"file        : {info['path']}")
    print(f"size        : {info['size']:,} bytes")
    print(f"sha256      : {info['sha256']}")
    print(f"family      : {info['family']}")
    if "error" in info:
        print(f"error       : {info['error']}")
        return 1
    for k, v in info.get("header", {}).items():
        print(f"{k:<12}: {v}")
    if info["family"] == FAMILY_WEB:
        print(f"concat      : {info['concat']} (prefix length implied by EOCD)")
        sig = info["signature_check"]
        state = "OK" if sig["verified"] else "NOT VERIFIED"
        print(f"signature   : {state}"
              + (f" -- {sig['reason']}" if sig["reason"] else "")
              + f"  [rsa-{sig['key_bits']}/sha1, version={sig['version']}]")
    print(f"entries     : {info['entry_count']} ({info['encrypted_entries']} encrypted)")
    for probe in ("pub/COMMITHASH", "pub/VERSION"):
        if probe in info:
            print(f"{probe:<12}: {info[probe]}")
    return 0


def cmd_list(args) -> int:
    info = parse(args.file)
    if "entries" not in info:
        print(f"error: {info.get('error', 'not a container')}", file=sys.stderr)
        return 1
    for e in info["entries"]:
        flag = "E" if e["encrypted"] else " "
        print(f"{flag} {e['size']:>10,} {e['compressed']:>10,}  {e['name']}")
    print(f"# {info['entry_count']} entries, {info['encrypted_entries']} encrypted")
    return 0


def cmd_extract(args) -> int:
    zf, family = _open_zip(args.file)
    out = args.out
    os.makedirs(out, exist_ok=True)
    skipped, written = [], 0
    with zf:
        for name in zf.namelist():
            if name.endswith("/"):
                continue
            dest = os.path.join(out, *name.split("/"))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            try:
                with zf.open(name) as src, open(dest, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                written += 1
            except RuntimeError as exc:
                # ZipCrypto-encrypted entry with no password available.
                skipped.append((name, str(exc)))
    print(f"[{family}] extracted {written} file(s) -> {out}")
    if skipped:
        print(f"skipped {len(skipped)} encrypted entry/entries (password required):")
        for name, why in skipped[:20]:
            print(f"  - {name}: {why}")
        if len(skipped) > 20:
            print(f"  ... and {len(skipped) - 20} more")
    return 0


def cmd_pack(args) -> int:
    """Rebuild a container from a directory.

    For Family A the 100-byte header is copied from --template (signature
    included, but it will no longer be valid since the body changed).  This is
    provided for analysis/reproduction only -- see docs/02-package-format-ntpk.md.
    """
    src = args.src
    if not os.path.isdir(src):
        raise SystemExit(f"error: {src} is not a directory")

    buf = io.BytesIO()
    files = []
    for base, _dirs, names in os.walk(src):
        for n in sorted(names):
            full = os.path.join(base, n)
            files.append((os.path.relpath(full, src).replace(os.sep, "/"), full))
    files.sort()

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # Directory entries first, in archive order, to mirror the original.
        seen_dirs = set()
        for rel, full in files:
            parts = rel.split("/")[:-1]
            for i in range(1, len(parts) + 1):
                d = "/".join(parts[:i]) + "/"
                if d not in seen_dirs:
                    seen_dirs.add(d)
                    zf.writestr(zipfile.ZipInfo(d), b"")
        for rel, full in files:
            zf.write(full, rel)
    body = buf.getvalue()

    if args.format == FAMILY_NTPK:
        header = b"NTPK" + struct.pack("<III", 0, len(body), NTPK_HEADER_BLOB)
        header += b"\x00" * NTPK_HEADER_BLOB
        out_bytes = header + body
    else:
        if args.template:
            with open(args.template, "rb") as fh:
                tpl = fh.read(4)
        else:
            tpl = b""
        if len(tpl) == 4:
            header = tpl + b"\x00" * (WEB_HEADER_LEN - 4)
        else:
            header = b"0003" + b"0" * 32 + b"\x00" * 64
        out_bytes = header + body

    with open(args.out, "wb") as fh:
        fh.write(out_bytes)
    print(f"wrote {args.out}: {len(out_bytes):,} bytes "
          f"(payload {len(body):,}, {len(files)} files)")
    if args.format == FAMILY_WEB:
        print("NOTE: the 100-byte signature was copied verbatim and is now INVALID.")
    return 0


def cmd_verify(args) -> int:
    with open(args.file, "rb") as fh:
        data = fh.read()
    if detect(data) != FAMILY_WEB:
        print(f"{args.file}: not a Family A (signed web pack) container")
        return 2
    res = verify_web_signature(data)
    if res["verified"]:
        print(f"{args.file}: signature OK (rsa-{res['key_bits']}/sha1, version {res['version']})")
        return 0
    print(f"{args.file}: signature NOT verified -- {res['reason']}")
    return 1


def cmd_diff(args) -> int:
    a, b = parse(args.a), parse(args.b)
    if "entries" not in a or "entries" not in b:
        print("error: one of the inputs is not a readable container", file=sys.stderr)
        return 1
    na = {e["name"]: e for e in a["entries"]}
    nb = {e["name"]: e for e in b["entries"]}
    only_a = sorted(set(na) - set(nb))
    only_b = sorted(set(nb) - set(na))
    common = sorted(set(na) & set(nb))
    changed = [n for n in common if na[n]["size"] != nb[n]["size"]]

    print(f"A: {a['path']}  ({a['entry_count']} entries)")
    print(f"B: {b['path']}  ({b['entry_count']} entries)")
    for label, key in (("COMMITHASH", "pub/COMMITHASH"), ("VERSION", "pub/VERSION")):
        print(f"{label:>10}: {a.get(key, '-')}  vs  {b.get(key, '-')}")
    print(f"only in A : {len(only_a)}")
    for n in only_a[:25]:
        print(f"   - {n}")
    print(f"only in B : {len(only_b)}")
    for n in only_b[:25]:
        print(f"   + {n}")
    print(f"common    : {len(common)} ({len(changed)} with different sizes)")
    for n in changed[:25]:
        print(f"   ~ {n}: {na[n]['size']} -> {nb[n]['size']}")
    return 0


# --------------------------------------------------------------------------- #

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="ntpk.py",
        description="Inspect/extract/repack NetEase Cloud Music (Orpheus) resource packs.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("info", help="describe a container")
    p.add_argument("file")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_info)

    p = sub.add_parser("list", help="list entries")
    p.add_argument("file")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("extract", help="extract entries to a directory")
    p.add_argument("file")
    p.add_argument("--out", "-o", required=True)
    p.set_defaults(func=cmd_extract)

    p = sub.add_parser("pack", help="rebuild a container from a directory")
    p.add_argument("src")
    p.add_argument("--out", "-o", required=True)
    p.add_argument("--format", choices=[FAMILY_WEB, FAMILY_NTPK], default=FAMILY_WEB)
    p.add_argument("--template", help="copy the 100-byte header from this file")
    p.set_defaults(func=cmd_pack)

    p = sub.add_parser("verify", help="verify a Family A signature")
    p.add_argument("file")
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("diff", help="compare two containers by entry name")
    p.add_argument("a")
    p.add_argument("b")
    p.set_defaults(func=cmd_diff)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
