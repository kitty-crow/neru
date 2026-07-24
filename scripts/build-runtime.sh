#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 022

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VARIANT="${LW_VARIANT:-wasm32_nommu}"
LINUX_WASM="$ROOT/vendor/linux-wasm"
WORKSPACE="${LW_WORKSPACE:-$LINUX_WASM/workspace}"
OUTPUT="${NERU_OUTPUT:-$ROOT/dist/neru-runtime-$VARIANT}"
KERNEL="${NERU_LINUX_KERNEL:-$WORKSPACE/install/kernel-$VARIANT/vmlinux.wasm}"

need() {
    command -v "$1" >/dev/null 2>&1 || {
        printf 'ERROR: Required command is missing: %s\n' "$1" >&2
        exit 1
    }
}

need_file() {
    [[ -f "$1" ]] || {
        printf 'ERROR: Required file is missing: %s\n' "$1" >&2
        exit 1
    }
}

for command in bash cp mkdir python3; do
    need "$command"
done

case "$VARIANT" in
    wasm32_nommu|wasm64_nommu) ;;
    *)
        printf 'ERROR: Unsupported NERU variant: %s\n' "$VARIANT" >&2
        exit 1
        ;;
esac

[[ -x "$LINUX_WASM/linux-wasm.sh" ]] || {
    printf 'ERROR: Linux-WASM submodule is not initialised: %s\n' "$LINUX_WASM" >&2
    exit 1
}

if [[ "${NERU_REBUILD_LINUX:-0}" == "1" || ! -f "$KERNEL" ]]; then
    printf '\n===== Build NERU Linux-WASM kernel =====\n'
    LW_VARIANT="$VARIANT" LW_WORKSPACE="$WORKSPACE" \
        "$ROOT/scripts/build-linux.sh" build-runtime
fi
need_file "$KERNEL"

printf '\n===== Assemble kernel-only NERU runtime =====\n'
mkdir -p "$OUTPUT"
cp "$KERNEL" "$OUTPUT/vmlinux.wasm"
cp "$LINUX_WASM/runtime/linux.js" "$OUTPUT/linux.js"
cp "$LINUX_WASM/runtime/linux-worker.js" "$OUTPUT/linux-worker.js"

python3 - "$OUTPUT" "$VARIANT" <<'PY'
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import sys

output = Path(sys.argv[1])
variant = sys.argv[2]

def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()

manifest = {
    "schema": 3,
    "mode": "kernel-only-live-userspace",
    "variant": variant,
    "filesystemBridgeSchema": 1,
    "rootFilesystem": "mikuosfs",
    "init": "/sbin/nemunemu",
    "containsInitramfs": False,
    "containsMikuOSUserspace": False,
    "containsNEMUNEMU": False,
    "artifacts": {
        name: {"sha256": digest(output / name), "bytes": (output / name).stat().st_size}
        for name in ("vmlinux.wasm", "linux.js", "linux-worker.js")
    },
}
(output / "manifest.json").write_text(
    json.dumps(manifest, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY

printf '\nNERU kernel-only runtime: %s\n' "$OUTPUT"
printf 'Linux kernel:             %s\n' "$OUTPUT/vmlinux.wasm"
printf 'Initramfs:                none\n'
printf 'Userspace:                live mikuOS root via mikuosfs\n'
printf 'PID 1:                    /sbin/nemunemu from live userspace\n'
