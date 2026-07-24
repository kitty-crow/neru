#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 022

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VARIANT="${LW_VARIANT:-wasm32_nommu}"
LINUX_WASM="$ROOT/vendor/linux-wasm"
NEMUNEMU="$ROOT/vendor/nemunemu"
WORKSPACE="${LW_WORKSPACE:-$LINUX_WASM/workspace}"
OUTPUT="${NERU_OUTPUT:-$ROOT/dist/neru-runtime-$VARIANT}"
KERNEL="${NERU_LINUX_KERNEL:-$WORKSPACE/install/kernel-$VARIANT/vmlinux.wasm}"
BASE_INITRAMFS="${NERU_BASE_INITRAMFS:-$WORKSPACE/install/initramfs-$VARIANT/initramfs.cpio.gz}"
NEMUNEMU_BINARY="${NEMUNEMU_BINARY:-$ROOT/dist/nemunemu-$VARIANT.wasm}"

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

for command in bash cpio cp fakeroot find gzip install mktemp python3 sort; do
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
[[ -x "$NEMUNEMU/scripts/build-linux-wasm.sh" ]] || {
    printf 'ERROR: NEMUNEMU submodule is not initialised: %s\n' "$NEMUNEMU" >&2
    exit 1
}

if [[ "${NERU_REBUILD_LINUX:-0}" == "1" || ! -f "$KERNEL" || ! -f "$BASE_INITRAMFS" ]]; then
    printf '\n===== Build NERU Linux-WASM base =====\n'
    LW_VARIANT="$VARIANT" LW_WORKSPACE="$WORKSPACE" \
        "$ROOT/scripts/build-linux.sh" build-os
fi
need_file "$KERNEL"
need_file "$BASE_INITRAMFS"

if [[ ! -f "$NEMUNEMU_BINARY" || "${NERU_REBUILD_NEMUNEMU:-0}" == "1" ]]; then
    printf '\n===== Build NEMUNEMU compatibility layer =====\n'
    LINUX_WASM_ROOT="$LINUX_WASM" \
    LW_WORKSPACE="$WORKSPACE" \
    LW_VARIANT="$VARIANT" \
    NEMUNEMU_WASM_OUTPUT="$NEMUNEMU_BINARY" \
        "$NEMUNEMU/scripts/build-linux-wasm.sh"
fi
need_file "$NEMUNEMU_BINARY"

TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
ROOTFS="$TEMP/root"
mkdir -p "$ROOTFS" "$OUTPUT"

printf '\n===== Prepare fixed NERU runtime initramfs =====\n'
fakeroot -- bash -c '
    set -Eeuo pipefail
    rootfs="$1"
    archive="$2"
    cd "$rootfs"
    gzip -dc "$archive" | cpio -idmu --quiet
' bash "$ROOTFS" "$BASE_INITRAMFS"

install -d \
    "$ROOTFS/dev" \
    "$ROOTFS/proc" \
    "$ROOTFS/sys" \
    "$ROOTFS/run" \
    "$ROOTFS/tmp" \
    "$ROOTFS/mikuos" \
    "$ROOTFS/sbin"
install -m 0755 "$NEMUNEMU_BINARY" "$ROOTFS/sbin/nemunemu"

cat > "$ROOTFS/init" <<'INIT'
#!/bin/sh
set -eu

mkdir -p /dev /proc /sys /run /tmp /mikuos
mount -t devtmpfs devtmpfs /dev 2>/dev/null || :
mount -t proc proc /proc 2>/dev/null || :
mount -t sysfs sysfs /sys 2>/dev/null || :

if command -v mount.mikuosfs >/dev/null 2>&1; then
    mount.mikuosfs /mikuos
elif [ -e /dev/mikuosfs ]; then
    mount -t mikuosfs mikuos /mikuos
else
    printf 'NERU_LIVE_BRIDGE_MISSING\n'
    printf 'The fixed NERU runtime booted, but the live mikuOS filesystem bridge is not installed yet.\n'
    exec /bin/sh
fi

exec /sbin/nemunemu --shell /mikuos
INIT
chmod 0755 "$ROOTFS/init"

printf '\n===== Pack fixed NERU runtime =====\n'
INITRAMFS="$OUTPUT/initramfs.cpio.gz"
fakeroot -- bash -c '
    set -Eeuo pipefail
    rootfs="$1"
    output="$2"
    cd "$rootfs"
    find . -print0 \
        | sort -z \
        | cpio --null -ov --format=newc --owner=0:0 2>/dev/null \
        | gzip -n -c > "$output"
' bash "$ROOTFS" "$INITRAMFS"

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
    "schema": 2,
    "mode": "live-userspace",
    "variant": variant,
    "filesystemBridgeSchema": 1,
    "containsMikuOSUserspace": False,
    "artifacts": {
        name: {"sha256": digest(output / name), "bytes": (output / name).stat().st_size}
        for name in ("vmlinux.wasm", "initramfs.cpio.gz", "linux.js", "linux-worker.js")
    },
}
(output / "manifest.json").write_text(
    json.dumps(manifest, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY

printf '\nNERU fixed runtime: %s\n' "$OUTPUT"
printf 'Linux kernel:      %s\n' "$OUTPUT/vmlinux.wasm"
printf 'Runtime initramfs: %s\n' "$INITRAMFS"
printf 'Userspace:         live bridge only, not packaged\n'
