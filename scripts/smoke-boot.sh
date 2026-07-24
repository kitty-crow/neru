#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_ROOT="${1:-${NERU_ARTIFACT_ROOT:-$ROOT/dist/neru-wasm32_nommu}}"
VARIANT="${NERU_LINUX_VARIANT:-wasm32_nommu}"
TIMEOUT_SECONDS="${NERU_SMOKE_TIMEOUT:-180}"
KERNEL="$ARTIFACT_ROOT/vmlinux.wasm"
INITRAMFS="$ARTIFACT_ROOT/initramfs.cpio.gz"
LOG="${NERU_SMOKE_LOG:-$ARTIFACT_ROOT/smoke-boot.log}"

for command in node timeout grep tee; do
    command -v "$command" >/dev/null 2>&1 || {
        printf 'ERROR: Required command is missing: %s\n' "$command" >&2
        exit 1
    }
done

for path in "$KERNEL" "$INITRAMFS"; do
    [[ -f "$path" ]] || {
        printf 'ERROR: NERU smoke artefact is missing: %s\n' "$path" >&2
        exit 1
    }
done

mkdir -p "$(dirname "$LOG")"
rm -f "$LOG"

CMDLINE="maxcpus=3 nohz_full=0,2-63 rcu_nocbs=0,2-63 root=/dev/ram0 rootfstype=ramfs init=/sbin/neru-smoke console=hvc console=ttyS0"

set +e
timeout --signal=TERM --kill-after=10 "$TIMEOUT_SECONDS" \
    node "$ROOT/bin/neru-linux-runtime.mjs" \
        --kernel "$KERNEL" \
        --initramfs "$INITRAMFS" \
        --variant "$VARIANT" \
        --cmdline "$CMDLINE" \
    2>&1 | tee "$LOG"
runtime_status=${PIPESTATUS[0]}
set -e

if grep -Fq 'NERU_SMOKE_FAIL:' "$LOG"; then
    printf 'ERROR: NERU guest smoke test reported failure.\n' >&2
    exit 1
fi

if ! grep -Fq 'NERU_SMOKE_OK' "$LOG"; then
    printf 'ERROR: NERU guest did not reach the smoke-test success marker (runtime status %s).\n' "$runtime_status" >&2
    exit 1
fi

printf 'NERU Linux-WASM smoke boot passed.\n'
