#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINUX_WASM="${LINUX_WASM_ROOT:-$ROOT/vendor/linux-wasm}"
WORKSPACE="${LW_WORKSPACE:-$LINUX_WASM/workspace}"
VARIANT="${LW_VARIANT:-wasm32_nommu}"
ARCH="${VARIANT%%_*}"
LLVM="$WORKSPACE/install/llvm"
SYSROOT="$WORKSPACE/install/musl-$VARIANT"
KERNEL_HEADERS="$WORKSPACE/install/kernel-$VARIANT/include"
CC="$LINUX_WASM/tools/fake-llvm/clang"
OUT="${NERUFS_WASM_OUTPUT:-$ROOT/dist/nerufs-$VARIANT.wasm}"

need_file() {
    [[ -f "$1" ]] || {
        printf 'ERROR: Required file is missing: %s\n' "$1" >&2
        exit 1
    }
}

need_file "$CC"
need_file "$LLVM/bin/clang"
need_file "$SYSROOT/lib/libc.a"
need_file "$KERNEL_HEADERS/linux/fuse.h"

mkdir -p "$(dirname "$OUT")"
export REAL_LLVM="$LLVM/bin"

"$CC" \
    --target=wasm-linux-musl \
    "-march=$ARCH" \
    --sysroot="$SYSROOT" \
    -isystem "$KERNEL_HEADERS" \
    -D__linux__ \
    -std=gnu17 \
    -O2 \
    -fPIC \
    -Wall -Wextra -Wpedantic -Werror \
    "$ROOT/src/nerufs.c" \
    "-m$ARCH" \
    -shared \
    -o "$OUT"

chmod 0755 "$OUT"
printf 'NERU shared-filesystem mount client: %s\n' "$OUT"
