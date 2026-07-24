#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 022

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINUX_WASM="$ROOT/vendor/linux-wasm"
NEMUNEMU="$ROOT/vendor/nemunemu"
WORKSPACE="${LW_WORKSPACE:-$LINUX_WASM/workspace}"
VARIANT="${LW_VARIANT:-wasm32_nommu}"
ROOTFS="${1:-}"

[[ -n "$ROOTFS" ]] || {
    printf 'Usage: %s MIKUOS_ROOT\n' "$0" >&2
    exit 64
}
ROOTFS="$(realpath -m "$ROOTFS")"
[[ "$ROOTFS" != "/" ]] || {
    printf 'ERROR: Refusing to install NERU files into the host root.\n' >&2
    exit 1
}

NEMUNEMU_BINARY="$ROOT/dist/nemunemu-$VARIANT.wasm"
BUSYBOX_BINARY="$WORKSPACE/install/busybox-$VARIANT/bin/busybox"

[[ -x "$NEMUNEMU/scripts/build-linux-wasm.sh" ]] || {
    printf 'ERROR: NEMUNEMU submodule is not initialised.\n' >&2
    exit 1
}

if [[ ! -f "$NEMUNEMU_BINARY" ]]; then
    printf '\n===== Build NEMUNEMU for Linux-WASM =====\n'
    LINUX_WASM_ROOT="$LINUX_WASM" \
    LW_WORKSPACE="$WORKSPACE" \
    LW_VARIANT="$VARIANT" \
    NEMUNEMU_WASM_OUTPUT="$NEMUNEMU_BINARY" \
        "$NEMUNEMU/scripts/build-linux-wasm.sh"
fi

[[ -f "$NEMUNEMU_BINARY" ]] || {
    printf 'ERROR: NEMUNEMU build did not produce %s\n' "$NEMUNEMU_BINARY" >&2
    exit 1
}
[[ -f "$BUSYBOX_BINARY" ]] || {
    printf 'ERROR: Linux-WASM BusyBox is missing: %s\n' "$BUSYBOX_BINARY" >&2
    printf 'The existing proof-of-concept workspace should contain it; do not rebuild LLVM.\n' >&2
    exit 1
}

printf '\n===== Install Linux compatibility files into live mikuOS root =====\n'
install -d -m 0755 \
    "$ROOTFS/bin" \
    "$ROOTFS/dev" \
    "$ROOTFS/etc" \
    "$ROOTFS/home" \
    "$ROOTFS/opt" \
    "$ROOTFS/proc" \
    "$ROOTFS/root" \
    "$ROOTFS/run" \
    "$ROOTFS/sbin" \
    "$ROOTFS/sys" \
    "$ROOTFS/tmp" \
    "$ROOTFS/usr/bin" \
    "$ROOTFS/usr/libexec/nemunemu" \
    "$ROOTFS/usr/sbin" \
    "$ROOTFS/var"
chmod 1777 "$ROOTFS/tmp"

install -m 0755 "$NEMUNEMU_BINARY" "$ROOTFS/sbin/nemunemu"
install -m 0755 "$BUSYBOX_BINARY" "$ROOTFS/usr/libexec/nemunemu/busybox"

printf 'Live mikuOS root: %s\n' "$ROOTFS"
printf 'PID 1:            %s\n' "$ROOTFS/sbin/nemunemu"
printf 'BusyBox:          %s\n' "$ROOTFS/usr/libexec/nemunemu/busybox"
printf 'NERU_LIVE_USERSPACE_OK\n'
