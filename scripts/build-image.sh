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

for command in bash cpio cp find gzip install mktemp python3 sort; do
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
    printf 'ERROR: Set NERU_USERLAND to the mikuOS userland root.\n' >&2
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
MIKUOS_ROOT="$ROOTFS/mikuos"
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

printf '\n===== Prepare mikuOS userland contracts =====\n'
python3 "$ROOT/scripts/prepare-userland.py" "$USERLAND" "$MIKUOS_ROOT"

install -d \
    "$ROOTFS/sbin" \
    "$MIKUOS_ROOT/dev" \
    "$MIKUOS_ROOT/proc" \
    "$MIKUOS_ROOT/sys" \
    "$MIKUOS_ROOT/sbin" \
    "$MIKUOS_ROOT/usr/libexec/neru" \
    "$MIKUOS_ROOT/usr/libexec/nemunemu"
install -m 0755 "$NEMUNEMU_BINARY" "$ROOTFS/sbin/nemunemu"
install -m 0755 "$NEMUNEMU_BINARY" "$MIKUOS_ROOT/sbin/nemunemu"
install -m 0755 -D "$BUSYBOX" "$MIKUOS_ROOT/usr/libexec/nemunemu/busybox"

SMOKE_STORED="$MIKUOS_ROOT/usr/libexec/nemunemu/thx/usr/libexec/neru/rv64-smoke.thx"
SMOKE_WRAPPER="$MIKUOS_ROOT/usr/libexec/neru/rv64-smoke"
python3 "$ROOT/scripts/make-rv64-smoke.py" "$SMOKE_STORED"
cat > "$SMOKE_WRAPPER" <<'WRAPPER'
#!/sbin/nemunemu --thx-wrapper
#!nemunemu-thx:/usr/libexec/nemunemu/thx/usr/libexec/neru/rv64-smoke.thx
WRAPPER
chmod 0755 "$SMOKE_WRAPPER"

cat > "$ROOTFS/init" <<'INIT'
#!/bin/sh
set -eu
mkdir -p /dev /proc /sys /mikuos/dev /mikuos/proc /mikuos/sys
mount -t devtmpfs devtmpfs /dev 2>/dev/null || :
mount -t proc proc /proc 2>/dev/null || :
mount -t sysfs sysfs /sys 2>/dev/null || :
mount --bind /dev /mikuos/dev 2>/dev/null || :
mount -t proc proc /mikuos/proc 2>/dev/null || :
mount -t sysfs sysfs /mikuos/sys 2>/dev/null || :
exec /sbin/nemunemu --shell /mikuos
INIT
chmod 0755 "$ROOTFS/init"

cat > "$ROOTFS/sbin/neru-smoke" <<'SMOKE'
#!/bin/sh
set -eu

finish() {
    /bin/busybox sync 2>/dev/null || :
    /bin/busybox poweroff -f 2>/dev/null || \
        /bin/busybox reboot -f 2>/dev/null || \
        /bin/busybox halt -f 2>/dev/null || :
    while :; do /bin/busybox sleep 1; done
}

fail() {
    printf 'NERU_SMOKE_FAIL:%s\n' "$*"
    finish
}

mkdir -p /dev /proc /sys /mikuos/dev /mikuos/proc /mikuos/sys
mount -t devtmpfs devtmpfs /dev 2>/dev/null || :
mount -t proc proc /proc 2>/dev/null || :
mount -t sysfs sysfs /sys 2>/dev/null || :
mount --bind /dev /mikuos/dev 2>/dev/null || :
mount -t proc proc /mikuos/proc 2>/dev/null || :
mount -t sysfs sysfs /mikuos/sys 2>/dev/null || :

kernel="$(/bin/busybox chroot /mikuos /bin/uname -s)" || fail uname
[ "$kernel" = "Linux" ] || fail "uname=$kernel"

/bin/busybox chroot /mikuos /bin/true || fail true
identity="$(/bin/busybox chroot /mikuos /bin/whoami)" || fail whoami
[ "$identity" = "root" ] || fail "whoami=$identity"

rv64="$(/bin/busybox chroot /mikuos /usr/libexec/neru/rv64-smoke)" || fail rv64
[ "$rv64" = "NERU_RV64_OK" ] || fail "rv64=$rv64"

printf 'NERU_SMOKE_OK\n'
finish
SMOKE
chmod 0755 "$ROOTFS/sbin/neru-smoke"

printf '\n===== Pack deterministic NERU image =====\n'
INITRAMFS="$OUTPUT/initramfs.cpio.gz"
(
    cd "$ROOTFS"
    find . -print0 \
        | sort -z \
        | cpio --null -ov --format=newc --owner=0:0 2>/dev/null \
        | gzip -n -c > "$INITRAMFS"
)

cp "$KERNEL" "$OUTPUT/vmlinux.wasm"
cp "$LINUX_WASM/runtime/linux.js" "$OUTPUT/linux.js"
cp "$LINUX_WASM/runtime/linux-worker.js" "$OUTPUT/linux-worker.js"

python3 - "$OUTPUT" "$VARIANT" "$USERLAND" <<'PY'
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import sys

output = Path(sys.argv[1])
variant = sys.argv[2]
userland = Path(sys.argv[3]).resolve()

def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()

manifest = {
    "schema": 1,
    "variant": variant,
    "userlandMetadataSha256": digest(userland / ".thistle-meta.json"),
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

printf '\nNERU artefacts: %s\n' "$OUTPUT"
printf 'Linux kernel:   %s\n' "$OUTPUT/vmlinux.wasm"
printf 'Linux image:    %s\n' "$INITRAMFS"
printf 'Web runtime:    %s\n' "$OUTPUT/linux.js"
