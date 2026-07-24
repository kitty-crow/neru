#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINUX_WASM="$ROOT/vendor/linux-wasm"
UPSTREAM="$LINUX_WASM/linux-wasm.sh"

[[ -x "$UPSTREAM" ]] || {
    printf 'ERROR: Linux-WASM submodule is not initialised: %s\n' "$LINUX_WASM" >&2
    exit 1
}

export LW_VARIANT="${LW_VARIANT:-wasm32_nommu}"
export LW_WORKSPACE="${LW_WORKSPACE:-$LINUX_WASM/workspace}"

ACTION="${1:-build-runtime}"
SOURCE_ROOT="$LW_WORKSPACE/src"
INSTALL_ROOT="$LW_WORKSPACE/install"
FETCH_RETRIES="${NERU_FETCH_RETRIES:-3}"

case "$FETCH_RETRIES" in
    ''|*[!0-9]*)
        printf 'ERROR: NERU_FETCH_RETRIES must be a positive integer.\n' >&2
        exit 1
        ;;
esac
[[ "$FETCH_RETRIES" -ge 1 ]] || {
    printf 'ERROR: NERU_FETCH_RETRIES must be at least 1.\n' >&2
    exit 1
}

source_valid() {
    local component="$1"
    local directory="$SOURCE_ROOT/$component"

    [[ -d "$directory/.git" ]] || return 1
    git -C "$directory" rev-parse --verify HEAD >/dev/null 2>&1 || return 1
    [[ ! -d "$directory/.git/rebase-apply" ]] || return 1
    [[ ! -d "$directory/.git/rebase-merge" ]] || return 1

    case "$component" in
        llvm)    [[ -f "$directory/llvm/CMakeLists.txt" ]] ;;
        kernel)  [[ -f "$directory/Makefile" && -d "$directory/arch/wasm" ]] ;;
        musl)    [[ -f "$directory/configure" ]] ;;
        busybox) [[ -f "$directory/Makefile" ]] ;;
        *)       return 1 ;;
    esac
}

fallback_clone() {
    local component="$1"
    local directory="$SOURCE_ROOT/$component"

    case "$component" in
        llvm)
            git -c http.version=HTTP/1.1 clone \
                --branch wasm-18.1.2 \
                --depth 1 \
                --single-branch \
                --no-tags \
                https://github.com/joelseverin/llvm.git \
                "$directory"
            ;;
        kernel)
            git -c http.version=HTTP/1.1 clone \
                --branch wasm-7.0 \
                --depth 1 \
                --single-branch \
                --no-tags \
                https://github.com/joelseverin/linux.git \
                "$directory"
            ;;
        *)
            return 1
            ;;
    esac
}

fetch_component() {
    local component="$1"
    local fetch_action="fetch-$component"
    local directory="$SOURCE_ROOT/$component"

    if source_valid "$component"; then
        printf 'NERU: reusing verified Linux-WASM source: %s\n' "$directory"
        return 0
    fi

    rm -rf "$directory"
    mkdir -p "$SOURCE_ROOT"

    local attempt
    for ((attempt = 1; attempt <= FETCH_RETRIES; attempt++)); do
        printf 'NERU: fetching Linux-WASM %s (attempt %d/%d)\n' \
            "$component" "$attempt" "$FETCH_RETRIES"

        rm -rf "$directory"
        if GIT_CONFIG_COUNT=1 \
           GIT_CONFIG_KEY_0=http.version \
           GIT_CONFIG_VALUE_0=HTTP/1.1 \
           "$UPSTREAM" "$fetch_action"; then
            if source_valid "$component"; then
                return 0
            fi
        fi

        rm -rf "$directory"
        if [[ "$attempt" -lt "$FETCH_RETRIES" ]]; then
            sleep "$((attempt * 5))"
        fi
    done

    if [[ "$component" == llvm || "$component" == kernel ]]; then
        printf 'NERU: upstream shallow-exclude fetch failed; trying depth-one %s clone\n' \
            "$component"
        rm -rf "$directory"
        if fallback_clone "$component" && source_valid "$component"; then
            return 0
        fi
    fi

    rm -rf "$directory"
    printf 'ERROR: Could not fetch a valid Linux-WASM %s source tree.\n' \
        "$component" >&2
    return 1
}

prepare_kernel_sources() {
    fetch_component llvm
    fetch_component kernel
}

prepare_os_sources() {
    prepare_kernel_sources
    fetch_component musl
    fetch_component busybox
}

build_tools_if_needed() {
    if [[ ! -x "$INSTALL_ROOT/llvm/bin/clang" ]]; then
        printf '\n===== Build Linux-WASM LLVM toolchain =====\n'
        "$UPSTREAM" build-tools
    fi
}

case "$ACTION" in
    build-runtime|build-kernel-only)
        prepare_kernel_sources
        build_tools_if_needed
        printf '\n===== Build Linux-WASM kernel only =====\n'
        exec "$UPSTREAM" build-kernel
        ;;
    all|build-os)
        prepare_os_sources
        build_tools_if_needed
        printf '\n===== Build Linux-WASM operating-system components =====\n'
        exec "$UPSTREAM" build-os
        ;;
    *)
        exec "$UPSTREAM" "$ACTION"
        ;;
esac
