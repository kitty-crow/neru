# NERU

NERU: Neru Executes a RUntime

NERU is the Linux-WASM kernel integration layer for Thistle systems. It boots a
Linux kernel directly against the same authoritative userspace used by Thistle
and Teto. It does not create or maintain another mikuOS installation.

## Architecture

```text
                   authoritative mikuOS userspace
                         selected root
                    /         |          \
               Thistle       Teto       NERU
                                           |
                                  Linux mikuosfs root
                                           |
                             /sbin/nemunemu as PID 1
```

The normal NERU release contains only:

```text
vmlinux.wasm
linux.js
linux-worker.js
manifest.json
```

There is no initramfs, BusyBox recovery image, copied `.thistle.base`, embedded
NEMUNEMU binary or private mikuOS root. Linux mounts `mikuosfs` as `/` and
executes `/sbin/nemunemu` from the live shared userspace.

`/dev`, `/proc`, `/sys`, `/run` and `/tmp` remain kernel-local runtime state.
The persistent mikuOS tree supplies `/etc`, `/home`, `/opt`, `/root`, `/usr`,
`/var`, `/sbin` and the rest of the installed system.

## Build the kernel-only runtime

```bash
git submodule update --init --recursive
npm install
npm run build
npm run build:runtime
```

The default output is:

```text
dist/neru-runtime-wasm32_nommu/
```

The build fetches and compiles only the LLVM tools and Linux kernel required by
NERU. It does not build musl, BusyBox or a launch filesystem for the normal
runtime.

## Boot from the same local root

```bash
bun neru.ts \
  --artifact-root dist/neru-runtime-wasm32_nommu \
  --fs-root /path/to/mikuOS/.thistle \
  --boot \
  --skip-build
```

When launched through mikuOS, the backend receives the exact root already
selected by `--root`, `MIKUOS_ROOT` or the normal `.thistle` default:

```bash
bun mikuos.ts --kernel=neru
bun mikuos.ts --kernel=neru --root /path/to/existing/root
```

The default kernel command line is equivalent to:

```text
maxcpus=1 root=mikuos rootfstype=mikuosfs rw init=/sbin/nemunemu
```

A remote authority remains available for browser or multi-host sessions:

```bash
bun neru.ts \
  --artifact-root dist/neru-runtime-wasm32_nommu \
  --fs-endpoint https://host.example/mikuos/ \
  --boot \
  --skip-build
```

The remaining implementation milestone is the built-in Linux `mikuosfs`
transport that converts VFS operations into host-directory or remote-authority
operations.

## Filesystem authority

The operation-level authority already exists under `src/fs`. It provides
monotonically increasing generations, per-inode conflict checks, atomic rename,
leases, advisory locks, durable commit markers and crash recovery.

For local execution the Linux guest bridge uses the exact host directory chosen
by mikuOS. For the browser it uses the same OPFS-backed tree selected by
Thistle and Teto. Remote clients may use the transaction protocol through an
authenticated service. The transport must not require repackaging the userspace.

## Original proof of concept

The first NERU implementation copied `.thistle.base` into an initramfs. That
work proved the Linux-WASM toolchain, NEMUNEMU packaging and real-kernel boot
path. It remains available only as an explicit regression experiment:

```bash
bun neru.ts \
  --poc-image \
  --userland /path/to/mikuOS/.thistle.base \
  --output dist/neru-poc-wasm32_nommu
```

The proof-of-concept path is not the production architecture and must never be
treated as a second writable mikuOS installation.
