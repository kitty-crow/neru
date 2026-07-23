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

"$LINUX_WASM/linux-wasm.sh" "$ACTION"

case "$ACTION" in
    all|build|build-os|all-kernel|build-kernel)
        ;;
    *)
        exit 0
        ;;
esac

KERNEL_SOURCE="$LW_WORKSPACE/src/kernel"
KERNEL_BUILD="$LW_WORKSPACE/build/kernel-$LW_VARIANT"
KERNEL_INSTALL="$LW_WORKSPACE/install/kernel-$LW_VARIANT"
REAL_LLVM="$LW_WORKSPACE/install/llvm/bin/"

[[ -x "$KERNEL_SOURCE/scripts/config" ]] || {
    printf 'ERROR: Linux kernel configuration helper is missing: %s\n' "$KERNEL_SOURCE/scripts/config" >&2
    exit 1
}

MAKE=(
    make
    "O=$KERNEL_BUILD"
    ARCH=wasm
    "LLVM=$LINUX_WASM/tools/fake-llvm/"
    "REAL_LLVM=$REAL_LLVM"
    CROSS_COMPILE=wasm32-unknown-unknown-
    HOSTCC=gcc
)

printf '\n===== Enable the NERU shared-filesystem mount =====\n'
(
    cd "$KERNEL_SOURCE"
    "${MAKE[@]}" "${LW_VARIANT}_defconfig"
    ./scripts/config --file "$KERNEL_BUILD/.config" \
        --enable CONFIG_FUSE_FS \
        --enable CONFIG_DEVTMPFS \
        --enable CONFIG_DEVTMPFS_MOUNT
    "${MAKE[@]}" olddefconfig
    "${MAKE[@]}" -j "${LW_JOBS_KERNEL_COMPILE:-16}" V=1
    "${MAKE[@]}" headers_install
)

mkdir -p "$KERNEL_INSTALL/include"
cp -R "$KERNEL_BUILD/usr/include/." "$KERNEL_INSTALL/include"
cp "$KERNEL_BUILD/vmlinux" "$KERNEL_INSTALL/vmlinux.wasm"

[[ "$(grep -E '^CONFIG_FUSE_FS=' "$KERNEL_BUILD/.config" || true)" == 'CONFIG_FUSE_FS=y' ]] || {
    printf 'ERROR: NERU kernel was built without CONFIG_FUSE_FS=y\n' >&2
    exit 1
}
