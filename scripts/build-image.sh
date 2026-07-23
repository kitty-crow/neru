#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 022

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VARIANT="${LW_VARIANT:-wasm32_nommu}"
LINUX_WASM="$ROOT/vendor/linux-wasm"
NEMUNEMU="$ROOT/vendor/nemunemu"
WORKSPACE="${LW_WORKSPACE:-$LINUX_WASM/workspace}"
USERLAND="${NERU_USERLAND:-}"
OUTPUT="${NERU_OUTPUT:-$ROOT/dist/neru-$VARIANT}"
KERNEL="${NERU_LINUX_KERNEL:-$WORKSPACE/install/kernel-$VARIANT/vmlinux.wasm}"
BASE_INITRAMFS="${NERU_BASE_INITRAMFS:-$WORKSPACE/install/initramfs-$VARIANT/initramfs.cpio.gz}"
NEMUNEMU_BINARY="${NEMUNEMU_BINARY:-$ROOT/dist/nemunemu-$VARIANT.wasm}"
NERUFS_BINARY="${NERUFS_BINARY:-$ROOT/dist/nerufs-$VARIANT.wasm}"
CHECKPOINT_GENERATION="${NERU_CHECKPOINT_GENERATION:-0}"
CHECKPOINT_CHECKSUM="${NERU_CHECKPOINT_CHECKSUM:-unknown}"

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

for command in bash cpio cp find gzip install mktemp python3 sort chmod; do
    need "$command"
done

case "$VARIANT" in
    wasm32_nommu|wasm64_nommu) ;;
    *)
        printf 'ERROR: Unsupported NERU variant: %s\n' "$VARIANT" >&2
        exit 1
        ;;
esac

[[ -n "$USERLAND" && -d "$USERLAND" ]] || {
    printf 'ERROR: Set NERU_USERLAND to a mikuOS userland root or materialised authority snapshot.\n' >&2
    exit 1
}
[[ -f "$USERLAND/.thistle-meta.json" && -f "$USERLAND/bin/thsh" ]] || {
    printf 'ERROR: Not a mikuOS userland root: %s\n' "$USERLAND" >&2
    exit 1
}
[[ -x "$LINUX_WASM/linux-wasm.sh" ]] || {
    printf 'ERROR: Linux-WASM submodule is not initialised: %s\n' "$LINUX_WASM" >&2
    exit 1
}
[[ -x "$NEMUNEMU/scripts/build-linux-wasm.sh" ]] || {
    printf 'ERROR: NEMUNEMU submodule is not initialised: %s\n' "$NEMUNEMU" >&2
    exit 1
}

if [[ "${NERU_REBUILD_LINUX:-0}" == "1" || ! -f "$KERNEL" || ! -f "$BASE_INITRAMFS" ]]; then
    printf '\n===== Build FUSE-enabled NERU Linux-WASM base =====\n'
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

if [[ ! -f "$NERUFS_BINARY" || "${NERU_REBUILD_NERUFS:-0}" == "1" ]]; then
    printf '\n===== Build NERU authoritative filesystem mount =====\n'
    LINUX_WASM_ROOT="$LINUX_WASM" \
    LW_WORKSPACE="$WORKSPACE" \
    LW_VARIANT="$VARIANT" \
    NERUFS_WASM_OUTPUT="$NERUFS_BINARY" \
        "$ROOT/scripts/build-nerufs.sh"
fi
need_file "$NERUFS_BINARY"

TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
ROOTFS="$TEMP/root"
CHECKPOINT="$ROOTFS/usr/lib/neru/checkpoint"
mkdir -p "$ROOTFS" "$OUTPUT"

printf '\n===== Unpack Linux-WASM initramfs =====\n'
(
    cd "$ROOTFS"
    gzip -dc "$BASE_INITRAMFS" | cpio -idmu --quiet
)

BUSYBOX="$ROOTFS/bin/busybox"
if [[ ! -f "$BUSYBOX" ]]; then
    BUSYBOX="$(find "$ROOTFS" -type f -name busybox -print -quit)"
fi
[[ -n "$BUSYBOX" && -f "$BUSYBOX" ]] || {
    printf 'ERROR: The Linux-WASM base initramfs contains no BusyBox binary.\n' >&2
    exit 1
}

printf '\n===== Build immutable mikuOS recovery checkpoint =====\n'
python3 "$ROOT/scripts/prepare-userland.py" "$USERLAND" "$CHECKPOINT"
install -d \
    "$ROOTFS/dev" \
    "$ROOTFS/proc" \
    "$ROOTFS/run" \
    "$ROOTFS/sbin" \
    "$ROOTFS/sys" \
    "$ROOTFS/mikuos" \
    "$ROOTFS/usr/lib/neru"
install -m 0755 "$NEMUNEMU_BINARY" "$ROOTFS/sbin/nemunemu"
install -m 0755 "$NERUFS_BINARY" "$ROOTFS/sbin/nerufs"
printf '%s\n' "$CHECKPOINT_GENERATION" > "$ROOTFS/usr/lib/neru/checkpoint-generation"
printf '%s\n' "$CHECKPOINT_CHECKSUM" > "$ROOTFS/usr/lib/neru/checkpoint-checksum"
chmod -R a-w "$CHECKPOINT"

cat > "$ROOTFS/init" <<'INIT'
#!/bin/sh
set -eu
mkdir -p /dev /proc /run /sys /mikuos
mount -t devtmpfs devtmpfs /dev
mount -t proc proc /proc
mount -t sysfs sysfs /sys

/sbin/nerufs /mikuos &
NERUFS_PID=$!
mounted=0
attempt=0
while [ "$attempt" -lt 200 ]; do
    if grep -qE '[[:space:]]/mikuos[[:space:]]+fuse([[:space:].]|$)' /proc/mounts; then
        mounted=1
        break
    fi
    if ! kill -0 "$NERUFS_PID" 2>/dev/null; then
        break
    fi
    attempt=$((attempt + 1))
    sleep 0.05
 done

if [ "$mounted" -ne 1 ]; then
    echo 'NERU: authoritative mikuOS userspace could not be mounted; refusing divergent boot.' >&2
    wait "$NERUFS_PID" 2>/dev/null || :
    exit 70
fi

mkdir -p /mikuos/dev /mikuos/proc /mikuos/run /mikuos/sys
mount --bind /dev /mikuos/dev
mount -t proc proc /mikuos/proc
mount -t sysfs sysfs /mikuos/sys
mount -t tmpfs tmpfs /mikuos/run

exec /sbin/nemunemu --shell /mikuos
INIT
chmod 0755 "$ROOTFS/init"

printf '\n===== Pack deterministic NERU boot image =====\n'
INITRAMFS="$OUTPUT/initramfs.cpio.gz"
(
    cd "$ROOTFS"
    find . -print0 \
        | sort -z \
        | cpio --null -ov --format=newc --owner=0:0 2>/dev/null \
        | gzip -n -c > "$INITRAMFS"
)

cp "$KERNEL" "$OUTPUT/vmlinux.wasm"
python3 "$ROOT/scripts/patch-linux-runtime.py" \
    --linux "$LINUX_WASM/runtime/linux.js" \
    --worker "$LINUX_WASM/runtime/linux-worker.js" \
    --output "$OUTPUT"

python3 - "$OUTPUT" "$VARIANT" "$USERLAND" "$CHECKPOINT_GENERATION" "$CHECKPOINT_CHECKSUM" <<'PY'
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import sys

output = Path(sys.argv[1])
variant = sys.argv[2]
userland = Path(sys.argv[3]).resolve()
generation = int(sys.argv[4])
checkpoint_checksum = sys.argv[5]

def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()

manifest = {
    "schema": 2,
    "variant": variant,
    "checkpoint": {
        "generation": generation,
        "checksum": checkpoint_checksum,
        "role": "immutable-base-and-recovery-only",
        "userlandMetadataSha256": digest(userland / ".thistle-meta.json"),
    },
    "sharedUserspace": {
        "required": True,
        "mountpoint": "/mikuos",
        "kernelLocal": ["/dev", "/proc", "/run", "/sys", "/tmp"],
    },
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

printf '\nNERU artefacts:       %s\n' "$OUTPUT"
printf 'Linux kernel:        %s\n' "$OUTPUT/vmlinux.wasm"
printf 'Linux boot image:    %s\n' "$INITRAMFS"
printf 'Checkpoint generation: %s\n' "$CHECKPOINT_GENERATION"
printf 'Authoritative mount: /mikuos (required at runtime)\n'
