# NERU

NERU: Neru Executes a RUntime

NERU is the Linux-WASM kernel integration layer for Thistle systems. It boots a
fixed Linux runtime and attaches the same authoritative userspace used by other
kernels. It does not create or maintain a second mikuOS installation.

## Architecture

```text
                   authoritative userspace service
                     generation + transaction log
                    /             |              \
             Thistle Tree     Teto Tree       NERU bridge
                                                   |
                                             Linux mikuosfs
                                                   |
                                              NEMUNEMU
```

The fixed NERU runtime contains only Linux, a minimal initramfs, NEMUNEMU,
BusyBox recovery tools and the host runtime. Persistent mikuOS paths are mounted
live from the filesystem authority. `/dev`, `/proc`, `/sys`, `/run` and `/tmp`
remain local to the active Linux session.

## Build the fixed runtime

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

It contains `vmlinux.wasm`, the fixed runtime `initramfs.cpio.gz`, browser
runtime files and a manifest. The manifest explicitly records that no mikuOS
userspace is embedded.

## Boot with a live filesystem authority

```bash
bun neru.ts \
  --artifact-root dist/neru-runtime-wasm32_nommu \
  --fs-endpoint http://127.0.0.1:3940 \
  --boot \
  --skip-build
```

The host-side authority and operation protocol already exist under `src/fs`.
The remaining implementation step is the Linux guest bridge and `mikuosfs`
mount path. Until that bridge is installed, the fixed runtime boots to a clear
`NERU_LIVE_BRIDGE_MISSING` recovery shell rather than fabricating a writable
copy of the userspace.

## Original proof of concept

The original architecture copied `.thistle.base` into a newly generated
initramfs and successfully exercised the Linux-WASM build, NEMUNEMU packaging
and real-kernel boot path. It is retained only as a proof of concept and
regression tool:

```bash
bun neru.ts \
  --poc-image \
  --userland /path/to/mikuOS/.thistle.base \
  --output dist/neru-poc-wasm32_nommu
```

That path is not the production architecture. Runtime writes must never be
written back into a packaged checkpoint image.

## Filesystem authority

Run a local authority with durable journalling:

```bash
npm run build
npm run fs -- --store /path/to/mikuos-userspace
```

The service publishes monotonically increasing generations, per-inode conflict
checks, atomic rename, leases, advisory locks, durable commit markers and crash
recovery. Browser and remote sessions use the same protocol through an
authoritative endpoint.

NEMUNEMU owns THX loading, Thistle execution and ABI translation. NERU owns the
Linux-visible shared mount so native Linux-WASM and THX processes see the same
persistent files. `uname` inside the guest reports the actual Linux release.
