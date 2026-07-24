#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINUX_WASM="$ROOT/vendor/linux-wasm"

[[ -x "$LINUX_WASM/linux-wasm.sh" ]] || {
    printf 'ERROR: Linux-WASM submodule is not initialised: %s\n' "$LINUX_WASM" >&2
    exit 1
}

export LW_VARIANT="${LW_VARIANT:-wasm32_nommu}"
export LW_WORKSPACE="${LW_WORKSPACE:-$LINUX_WASM/workspace}"

ACTION="${1:-build-os}"
if [[ "$ACTION" == "build-os" ]]; then
    for required in \
        "$LW_WORKSPACE/install/llvm/bin/clang" \
        "$LW_WORKSPACE/src/kernel" \
        "$LW_WORKSPACE/src/musl" \
        "$LW_WORKSPACE/src/busybox"
    do
        if [[ ! -e "$required" ]]; then
            ACTION="all"
            break
        fi
    done
fi

exec "$LINUX_WASM/linux-wasm.sh" "$ACTION"
