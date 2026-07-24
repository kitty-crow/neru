# NERU

NERU: Neru Executes a RUntime

NERU is the Linux-WASM kernel integration layer for Thistle systems. It boots a
Linux kernel directly against the same authoritative userspace used by Thistle
and Teto. It does not create or maintain another mikuOS installation.

## Architecture

```text
                   authoritative mikuOS userspace
                         Tree authority
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

## Boot from the live userspace

```bash
bun neru.ts \
  --artifact-root dist/neru-runtime-wasm32_nommu \
  --fs-endpoint http://127.0.0.1:3940 \
  --boot \
  --skip-build
```

The default kernel command line is equivalent to:

```text
maxcpus=1 root=mikuos rootfstype=mikuosfs rw init=/sbin/nemunemu
```

The filesystem endpoint must expose the same selected mikuOS root used by the
Thistle and Teto host. The host runtime passes that authority into the Linux
workers. The remaining implementation milestone is the built-in Linux
`mikuosfs` transport that converts VFS operations into the existing NERU shared
filesystem protocol.

## Filesystem authority

The operation-level authority already exists under `src/fs`. It provides
monotonically increasing generations, per-inode conflict checks, atomic rename,
leases, advisory locks, durable commit markers and crash recovery.

For local execution the Linux guest bridge should use shared memory and atomics
to reach the host worker. The authority may be backed by the same host directory
selected through mikuOS `--root`, OPFS in the browser, or a remote shared
service. The transport must not require repackaging the userspace.

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
