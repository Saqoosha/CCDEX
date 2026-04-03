#!/usr/bin/env python3
"""
CCDEX Patcher — Patches Claude Desktop's app.asar to inject context-indicator.js

Usage:
    python3 patch.py [--install]

Without --install: creates /tmp/app-patched.asar
With --install: also copies to Claude.app and re-signs (requires sudo)
"""

import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys

CLAUDE_APP = "/Applications/Claude.app"
ASAR_PATH = os.path.join(CLAUDE_APP, "Contents", "Resources", "app.asar")
INFO_PLIST = os.path.join(CLAUDE_APP, "Contents", "Info.plist")
INJECT_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "context-indicator.js")
OUTPUT_ASAR = "/tmp/app-patched.asar"
BACKUP_ASAR = "/tmp/claude-app-backup.asar"
TARGET_FILE = ".vite/build/mainView.js"
FUSE_TOOL = "@electron/fuses@1.8.0"


def read_asar_header(data: bytes) -> tuple[dict, int, int]:
    """Parse ASAR header. Returns (header_dict, header_total_bytes, header_string_size)."""
    vals = struct.unpack("<IIII", data[:16])
    header_string_size = vals[3]
    header_json = data[16 : 16 + header_string_size].decode("utf-8")
    header = json.loads(header_json)
    header_total = 8 + vals[1]
    return header, header_total, header_string_size


def find_file_node(header: dict, path: str) -> dict:
    """Navigate the ASAR header tree to find a file entry."""
    parts = path.split("/")
    node = header
    for part in parts:
        node = node["files"][part]
    return node


def shift_offsets(node: dict, threshold: int, delta: int):
    """Shift file offsets greater than threshold by delta bytes."""
    if "files" in node:
        for child in node["files"].values():
            shift_offsets(child, threshold, delta)
    elif "offset" in node:
        off = int(node["offset"])
        if off > threshold:
            node["offset"] = str(off + delta)


def build_asar_header(header: dict, original_header_total: int) -> bytes:
    """Serialize header dict back to ASAR binary header format."""
    header_json = json.dumps(header, separators=(",", ":"), ensure_ascii=False)
    header_bytes = header_json.encode("utf-8")
    header_string_size = len(header_bytes)

    # Pickle format with 4-byte alignment
    pickle_content_size = 4 + header_string_size
    padding = (4 - (pickle_content_size % 4)) % 4
    padded_pickle_content_size = pickle_content_size + padding

    header_block = struct.pack(
        "<IIII",
        4,
        padded_pickle_content_size + 4,
        padded_pickle_content_size,
        header_string_size,
    )
    header_block += header_bytes + b"\0" * padding

    if len(header_block) != original_header_total:
        raise RuntimeError(
            f"Header size changed: {original_header_total} -> {len(header_block)}. "
            "This patcher assumes header size stays constant. "
            "If the injection script name/path changes, this may need updating."
        )

    return header_block


def patch_asar(asar_path: str, inject_path: str, output_path: str) -> str:
    """
    Patch mainView.js inside an ASAR file.
    Returns the SHA256 hash of the output ASAR.
    """
    with open(inject_path, "rb") as f:
        inject_bytes = f.read()

    with open(asar_path, "rb") as f:
        raw = f.read()

    header, header_total, _ = read_asar_header(raw)
    node = find_file_node(header, TARGET_FILE)
    original_offset = int(node["offset"])
    original_size = node["size"]

    # Read original file content and verify
    abs_offset = header_total + original_offset
    original_content = raw[abs_offset : abs_offset + original_size]
    if not original_content.startswith(b'"use strict"'):
        raise RuntimeError("mainView.js doesn't start with expected content — wrong file?")

    # Check if already patched
    if b"[CCDEX]" in original_content:
        print("WARNING: mainView.js already contains CCDEX injection. Re-patching.")
        # Strip old injection (everything after the original sourcemap comment)
        marker = b"//# sourceMappingURL=mainView.js.map"
        idx = original_content.find(marker)
        if idx >= 0:
            original_content = original_content[: idx + len(marker)]
        else:
            raise RuntimeError("Cannot find sourcemap marker to strip old injection")

    # Create patched content
    patched_content = original_content + b"\n" + inject_bytes
    size_diff = len(patched_content) - original_size

    # Update header
    new_hash = hashlib.sha256(patched_content).hexdigest()
    node["size"] = len(patched_content)
    node["integrity"]["hash"] = new_hash
    node["integrity"]["blocks"] = [new_hash]

    # Shift offsets of files after mainView.js
    shift_offsets(header, original_offset, size_diff)

    # Rebuild
    new_header = build_asar_header(header, header_total)
    data_section = raw[header_total:]
    before = data_section[:original_offset]
    after = data_section[original_offset + original_size :]
    output = new_header + before + patched_content + after

    with open(output_path, "wb") as f:
        f.write(output)

    asar_hash = hashlib.sha256(output).hexdigest()
    return asar_hash


def _run_fuse_tool(args: list[str]) -> subprocess.CompletedProcess | None:
    """Run fuse tool, trying npx first then bun x as fallback."""
    for runner in [["npx"], ["bun", "x"]]:
        try:
            result = subprocess.run(
                runner + [FUSE_TOOL] + args,
                capture_output=True, text=True, timeout=60,
            )
            output = result.stdout + result.stderr
            # Success if we see expected output patterns
            if "Fuse Version" in output or "Fuses written" in output:
                return result
        except Exception:
            continue
    return None


def check_fuses():
    """Check if ASAR integrity fuse is disabled."""
    result = _run_fuse_tool(["read", "--app", CLAUDE_APP])
    if result is None:
        print("WARNING: Could not determine fuse state. Proceeding anyway.")
        return None
    output = result.stdout + result.stderr
    if "EnableEmbeddedAsarIntegrityValidation is Enabled" in output:
        return False
    if "EnableEmbeddedAsarIntegrityValidation is Disabled" in output:
        return True
    print("WARNING: Could not determine fuse state. Proceeding anyway.")
    return None


def disable_fuse():
    """Disable ASAR integrity fuse."""
    print("Disabling EnableEmbeddedAsarIntegrityValidation fuse...")
    result = _run_fuse_tool(["write", "--app", CLAUDE_APP,
                             "EnableEmbeddedAsarIntegrityValidation=off"])
    if result is None or result.returncode != 0:
        stderr = result.stderr if result else "(tool not found)"
        print(f"ERROR: Failed to disable fuse: {stderr}")
        print("Try manually:")
        print(f"  npx {FUSE_TOOL} write --app \"{CLAUDE_APP}\" EnableEmbeddedAsarIntegrityValidation=off")
        print(f"  # or: bun x {FUSE_TOOL} write --app \"{CLAUDE_APP}\" EnableEmbeddedAsarIntegrityValidation=off")
        return False
    print("Fuse disabled.")
    return True


def resign_app():
    """Re-sign Claude.app with an ad-hoc signature (no sudo needed)."""
    print("Re-signing Claude.app (ad-hoc)...")
    subprocess.run(
        ["codesign", "--force", "--deep", "--sign", "-", CLAUDE_APP],
        check=True,
    )
    print("Re-signed.")


def install_asar(patched_path: str):
    """Copy patched ASAR to Claude.app and re-sign."""
    print(f"Installing {patched_path} -> {ASAR_PATH}")
    subprocess.run(["cp", patched_path, ASAR_PATH], check=True)
    resign_app()
    print("Installed and signed.")


def main():
    do_install = "--install" in sys.argv

    # Preflight checks
    if not os.path.exists(CLAUDE_APP):
        print(f"ERROR: Claude Desktop not found at {CLAUDE_APP}")
        sys.exit(1)

    if not os.path.exists(ASAR_PATH):
        print(f"ERROR: app.asar not found at {ASAR_PATH}")
        sys.exit(1)

    if not os.path.exists(INJECT_SCRIPT):
        print(f"ERROR: context-indicator.js not found at {INJECT_SCRIPT}")
        sys.exit(1)

    # Check fuses
    print("Checking Electron fuses...")
    fuse_ok = check_fuses()
    if fuse_ok is False:
        print("ASAR integrity fuse is ENABLED — must disable first.")
        if not disable_fuse():
            sys.exit(1)
    elif fuse_ok is True:
        print("ASAR integrity fuse is already disabled.")
    else:
        print("WARNING: Could not determine fuse state. Proceeding anyway.")

    # Backup
    if not os.path.exists(BACKUP_ASAR):
        print(f"Backing up original ASAR to {BACKUP_ASAR}")
        shutil.copy2(ASAR_PATH, BACKUP_ASAR)
    else:
        print(f"Backup already exists at {BACKUP_ASAR}")

    # Patch
    print(f"Patching {ASAR_PATH}...")
    print(f"  Injecting: {INJECT_SCRIPT}")
    print(f"  Target: {TARGET_FILE}")
    asar_hash = patch_asar(ASAR_PATH, INJECT_SCRIPT, OUTPUT_ASAR)
    print(f"  Output: {OUTPUT_ASAR}")
    print(f"  SHA256: {asar_hash}")

    if do_install:
        install_asar(OUTPUT_ASAR)
        print("\nDone! Launch Claude Desktop to verify.")
    else:
        print(f"\nPatched ASAR written to {OUTPUT_ASAR}")
        print("To install, run:")
        print(f"  cp {OUTPUT_ASAR} \"{ASAR_PATH}\"")
        print(f"  codesign --force --deep --sign - \"{CLAUDE_APP}\"")
        print("\nOr re-run with --install flag:")
        print(f"  python3 {sys.argv[0]} --install")


if __name__ == "__main__":
    main()
