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
BUSYBOX_SOURCE_CONFIG="$WORKSPACE/src/busybox/configs/wasm_defconfig"
BUSYBOX_BUILD_CONFIG="$WORKSPACE/build/busybox-$VARIANT/.config"
BUSYBOX_PROFILE_MARKER="$WORKSPACE/install/busybox-$VARIANT/.neru-pid1-shell-v2"

[[ -x "$NEMUNEMU/scripts/build-linux-wasm.sh" ]] || {
    printf 'ERROR: NEMUNEMU submodule is not initialised.\n' >&2
    exit 1
}

printf '\n===== Build current NEMUNEMU for Linux-WASM =====\n'
LINUX_WASM_ROOT="$LINUX_WASM" \
LW_WORKSPACE="$WORKSPACE" \
LW_VARIANT="$VARIANT" \
NEMUNEMU_WASM_OUTPUT="$NEMUNEMU_BINARY" \
    "$NEMUNEMU/scripts/build-linux-wasm.sh"

[[ -f "$NEMUNEMU_BINARY" ]] || {
    printf 'ERROR: NEMUNEMU build did not produce %s\n' "$NEMUNEMU_BINARY" >&2
    exit 1
}

busybox_profile_ready() {
    [[ -f "$BUSYBOX_BINARY" && -f "$BUSYBOX_PROFILE_MARKER" && -f "$BUSYBOX_BUILD_CONFIG" ]] || return 1
    grep -qx '# CONFIG_FEATURE_PREFER_APPLETS is not set' "$BUSYBOX_BUILD_CONFIG" || return 1
    grep -qx '# CONFIG_FEATURE_SH_STANDALONE is not set' "$BUSYBOX_BUILD_CONFIG" || return 1
    grep -qx '# CONFIG_FEATURE_SH_NOFORK is not set' "$BUSYBOX_BUILD_CONFIG" || return 1
    grep -qx '# CONFIG_HUSH_JOB is not set' "$BUSYBOX_BUILD_CONFIG" || return 1
}

if ! busybox_profile_ready; then
    [[ -f "$BUSYBOX_SOURCE_CONFIG" ]] || {
        printf 'ERROR: Linux-WASM BusyBox source config is missing: %s\n' "$BUSYBOX_SOURCE_CONFIG" >&2
        printf 'The existing proof-of-concept workspace must contain fetched BusyBox sources.\n' >&2
        exit 1
    }

    printf '\n===== Configure PID 1-safe Linux-WASM BusyBox =====\n'
    python3 - "$BUSYBOX_SOURCE_CONFIG" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")

# WebAssembly NOMMU currently cannot safely use BusyBox's indirect NOFORK
# applet dispatch: it can trap with an out-of-bounds function-table index.
# Disabling hush job control is still required so the shell never hands the
# terminal to a child process and leaves the host shell in the foreground.
settings = {
    "CONFIG_FEATURE_PREFER_APPLETS": False,
    "CONFIG_FEATURE_SH_STANDALONE": False,
    "CONFIG_FEATURE_SH_NOFORK": False,
    "CONFIG_HUSH_JOB": False,
}

lines = text.splitlines()
for name, enabled in settings.items():
    yes = f"{name}=y"
    no = f"# {name} is not set"
    desired = yes if enabled else no
    if yes not in lines and no not in lines:
        raise SystemExit(f"ERROR: BusyBox config does not contain {name}")
    text = text.replace(yes, desired).replace(no, desired)

path.write_text(text, encoding="utf-8")
PY

    rm -f \
        "$WORKSPACE/install/busybox-$VARIANT/.neru-pid1-shell-v1" \
        "$BUSYBOX_PROFILE_MARKER"
    LW_WORKSPACE="$WORKSPACE" \
    LW_VARIANT="$VARIANT" \
        "$LINUX_WASM/linux-wasm.sh" build-busybox

    [[ -f "$BUSYBOX_BINARY" ]] || {
        printf 'ERROR: PID 1-safe BusyBox build did not produce %s\n' "$BUSYBOX_BINARY" >&2
        exit 1
    }
    touch "$BUSYBOX_PROFILE_MARKER"
fi

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

# Expose the BusyBox rescue commands through the normal PATH, but never replace
# a real mikuOS command already present in either /bin or /usr/bin. Relative
# links keep the live userspace relocatable as one authoritative directory.
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
done

# Conventional script interpreters expect /bin/sh specifically. Preserve any
# existing mikuOS implementation and add the BusyBox hush-backed link only when
# the path is genuinely absent.
if [[ ! -e "$ROOTFS/bin/sh" && ! -L "$ROOTFS/bin/sh" ]]; then
    ln -s ../usr/libexec/nemunemu/busybox "$ROOTFS/bin/sh"
    compatibility_links=$((compatibility_links + 1))
fi

printf 'Live mikuOS root:    %s\n' "$ROOTFS"
printf 'PID 1:               %s\n' "$ROOTFS/sbin/nemunemu"
printf 'BusyBox:             %s\n' "$ROOTFS/usr/libexec/nemunemu/busybox"
printf 'Compatibility links: %s created\n' "$compatibility_links"
printf 'NERU_LIVE_USERSPACE_OK\n'
