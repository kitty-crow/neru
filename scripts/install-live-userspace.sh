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
BUSYBOX_SOURCE="$WORKSPACE/src/busybox"
BUSYBOX_BINARY="$WORKSPACE/install/busybox-$VARIANT/bin/busybox"
BUSYBOX_BUILD_CONFIG="$WORKSPACE/build/busybox-$VARIANT/.config"
BUSYBOX_PROFILE_MARKER="$WORKSPACE/install/busybox-$VARIANT/.neru-supervised-shell-v1"

LLVM="$WORKSPACE/install/llvm/bin/clang"
MUSL="$WORKSPACE/install/musl-$VARIANT/lib/libc.a"
KERNEL_HEADERS="$WORKSPACE/install/kernel-$VARIANT/include/linux/types.h"
FAKE_CLANG="$LINUX_WASM/tools/fake-llvm/clang"

source_newer_than() {
    local target="$1"
    shift

    local source
    for source in "$@"; do
        if [[ -f "$source" ]]; then
            [[ "$source" -nt "$target" ]] && return 0
        elif [[ -d "$source" ]]; then
            if [[ -n "$(
                find "$source" \
                    \( -path '*/.git' \
                       -o -path '*/build' \
                       -o -path '*/dist' \
                       -o -path '*/node_modules' \) -prune \
                    -o -type f -newer "$target" -print -quit
            )" ]]; then
                return 0
            fi
        fi
    done

    return 1
}

changed=0

printf '\n===== Prepare Linux-WASM build dependencies =====\n'

dependencies_ready=true

for required in \
    "$FAKE_CLANG" \
    "$LLVM" \
    "$MUSL" \
    "$KERNEL_HEADERS" \
    "$BUSYBOX_BINARY"; do
    [[ -f "$required" ]] || dependencies_ready=false
done

if [[ "$dependencies_ready" == false ]]; then
    LW_WORKSPACE="$WORKSPACE" LW_VARIANT="$VARIANT" \
        "$ROOT/scripts/build-linux.sh" all
    changed=1
else
    printf 'NERU: reusing current Linux-WASM toolchain and userspace dependencies.\n'
fi

for required in \
    "$FAKE_CLANG" \
    "$LLVM" \
    "$MUSL" \
    "$KERNEL_HEADERS" \
    "$BUSYBOX_BINARY"; do
    [[ -f "$required" ]] || {
        printf 'ERROR: Required Linux-WASM dependency is missing: %s\n' "$required" >&2
        exit 1
    }
done

[[ -x "$NEMUNEMU/scripts/build-linux-wasm.sh" ]] || {
    printf 'ERROR: NEMUNEMU submodule is not initialised.\n' >&2
    exit 1
}

nemunemu_stale=false

if [[ ! -f "$NEMUNEMU_BINARY" ]]; then
    nemunemu_stale=true
elif source_newer_than "$NEMUNEMU_BINARY" \
    "$NEMUNEMU/CMakeLists.txt" \
    "$NEMUNEMU/include" \
    "$NEMUNEMU/src" \
    "$NEMUNEMU/scripts" \
    "$NEMUNEMU/vendor/thistle"; then
    nemunemu_stale=true
fi

if [[ "$nemunemu_stale" == true ]]; then
    printf '\n===== Build current NEMUNEMU for Linux-WASM =====\n'

    LINUX_WASM_ROOT="$LINUX_WASM" \
    LW_WORKSPACE="$WORKSPACE" \
    LW_VARIANT="$VARIANT" \
    NEMUNEMU_WASM_OUTPUT="$NEMUNEMU_BINARY" \
        "$NEMUNEMU/scripts/build-linux-wasm.sh"

    changed=1
else
    printf 'NERU: reusing current NEMUNEMU binary: %s\n' "$NEMUNEMU_BINARY"
fi

[[ -f "$NEMUNEMU_BINARY" ]] || {
    printf 'ERROR: NEMUNEMU binary is missing: %s\n' "$NEMUNEMU_BINARY" >&2
    exit 1
}

busybox_profile_ready() {
    [[ -f "$BUSYBOX_BINARY" ]] || return 1
    [[ -f "$BUSYBOX_PROFILE_MARKER" ]] || return 1
    [[ -f "$BUSYBOX_BUILD_CONFIG" ]] || return 1

    grep -qx '# CONFIG_FEATURE_PREFER_APPLETS is not set' \
        "$BUSYBOX_BUILD_CONFIG" || return 1
    grep -qx '# CONFIG_FEATURE_SH_STANDALONE is not set' \
        "$BUSYBOX_BUILD_CONFIG" || return 1
    grep -qx '# CONFIG_FEATURE_SH_NOFORK is not set' \
        "$BUSYBOX_BUILD_CONFIG" || return 1
    grep -qx 'CONFIG_HUSH_JOB=y' \
        "$BUSYBOX_BUILD_CONFIG" || return 1

    git -C "$BUSYBOX_SOURCE" diff --quiet -- \
        configs/wasm_defconfig shell/hush.c || return 1

    source_newer_than "$BUSYBOX_BINARY" \
        "$BUSYBOX_SOURCE/configs/wasm_defconfig" \
        "$BUSYBOX_SOURCE/shell/hush.c" && return 1

    return 0
}

if busybox_profile_ready; then
    printf 'NERU: reusing current supervised-shell BusyBox profile.\n'
else
    [[ -d "$BUSYBOX_SOURCE/.git" ]] || {
        printf 'ERROR: Linux-WASM BusyBox source is missing: %s\n' \
            "$BUSYBOX_SOURCE" >&2
        exit 1
    }

    printf '\n===== Restore upstream Linux-WASM BusyBox sources =====\n'

    git -C "$BUSYBOX_SOURCE" checkout -- \
        configs/wasm_defconfig \
        shell/hush.c

    printf '\n===== Clean-build upstream Linux-WASM BusyBox =====\n'

    rm -rf \
        "$WORKSPACE/build/busybox-$VARIANT" \
        "$WORKSPACE/install/busybox-$VARIANT"

    LW_WORKSPACE="$WORKSPACE" \
    LW_VARIANT="$VARIANT" \
        "$LINUX_WASM/linux-wasm.sh" build-busybox

    [[ -f "$BUSYBOX_BINARY" ]] || {
        printf 'ERROR: BusyBox build did not produce %s\n' \
            "$BUSYBOX_BINARY" >&2
        exit 1
    }

    [[ -f "$BUSYBOX_BUILD_CONFIG" ]] || {
        printf 'ERROR: BusyBox build did not produce %s\n' \
            "$BUSYBOX_BUILD_CONFIG" >&2
        exit 1
    }

    required_settings=(
        '# CONFIG_FEATURE_PREFER_APPLETS is not set'
        '# CONFIG_FEATURE_SH_STANDALONE is not set'
        '# CONFIG_FEATURE_SH_NOFORK is not set'
        'CONFIG_HUSH_JOB=y'
    )

    for setting in "${required_settings[@]}"; do
        grep -Fx "$setting" "$BUSYBOX_BUILD_CONFIG" >/dev/null || {
            printf 'ERROR: BusyBox profile is missing: %s\n' "$setting" >&2
            exit 1
        }
    done

    touch "$BUSYBOX_PROFILE_MARKER"
    changed=1
fi

printf '\n===== Prepare live mikuOS root =====\n'

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

install_if_different() {
    local source="$1"
    local destination="$2"
    local mode="$3"
    local label="$4"

    if [[ -f "$destination" ]] && cmp -s "$source" "$destination"; then
        printf 'NERU: reusing installed %s: %s\n' "$label" "$destination"
        return
    fi

    install -m "$mode" "$source" "$destination"
    printf 'NERU: installed %s: %s\n' "$label" "$destination"
    changed=1
}

install_if_different \
    "$NEMUNEMU_BINARY" \
    "$ROOTFS/sbin/nemunemu" \
    0755 \
    NEMUNEMU

install_if_different \
    "$BUSYBOX_BINARY" \
    "$ROOTFS/usr/libexec/nemunemu/busybox" \
    0755 \
    BusyBox

BUSYBOX_APPLETS=(
    '[' base64 basename cat chmod chown clear cp cut date df dirname dmesg
    echo env expr false file find free grep head hostname id kill ln ls mkdir
    mount mv printenv printf ps pwd readlink rm rmdir sed seq sh sleep sort stat
    strings tail tee test time touch tr true uname uniq uptime wc wget which
    whoami yes
)

compatibility_links=0

for applet in "${BUSYBOX_APPLETS[@]}"; do
    bin_path="$ROOTFS/bin/$applet"
    usr_path="$ROOTFS/usr/bin/$applet"

    if [[ -e "$bin_path" || -L "$bin_path" || -e "$usr_path" || -L "$usr_path" ]]; then
        continue
    fi

    ln -s ../libexec/nemunemu/busybox "$usr_path"
    compatibility_links=$((compatibility_links + 1))
    changed=1
done

if [[ ! -e "$ROOTFS/bin/sh" && ! -L "$ROOTFS/bin/sh" ]]; then
    ln -s ../usr/libexec/nemunemu/busybox "$ROOTFS/bin/sh"
    compatibility_links=$((compatibility_links + 1))
    changed=1
fi

printf 'Live mikuOS root:    %s\n' "$ROOTFS"
printf 'PID 1:               %s\n' "$ROOTFS/sbin/nemunemu"
printf 'BusyBox:             %s\n' "$ROOTFS/usr/libexec/nemunemu/busybox"
printf 'Compatibility links: %s created\n' "$compatibility_links"

if [[ "$changed" -eq 0 ]]; then
    printf 'NERU_LIVE_USERSPACE_REUSED\n'
else
    printf 'NERU_LIVE_USERSPACE_READY\n'
fi
