# NERU

NERU: Neru Executes a RUntime

NERU is the ahead-of-time Linux-WASM image builder and kernel-integration
layer for Thistle systems. It builds the Linux kernel, initramfs, NEMUNEMU
compatibility environment and immutable recovery checkpoint used by both CLI
and web hosts.

NERU does **not** create or maintain a second mikuOS installation. Thistle,
Teto and NERU/Linux attach the same authoritative persistent userspace through
the operation-level service documented in `docs/SHARED_USERSPACE.md`.

## Authoritative userspace

Run a local authority with durable journalling:

```bash
npm install
npm run build
npm run fs -- --store /path/to/mikuos-userspace
```

The service publishes monotonically increasing generations, per-inode conflict
checks, atomic rename, leases, advisory locks, durable commit markers and crash
recovery. A remote endpoint provides the same contract to browser sessions and
other machines.

## Build an image

```bash
git submodule update --init --recursive
npm install
npm run build
bun neru.ts --userland /path/to/mikuOS/.thistle.base --output dist/neru-wasm32_nommu
```

The supplied userland is used as an immutable base/checkpoint. Runtime writes
must go to the authoritative service, never back into the checkpoint image.
The output directory contains `vmlinux.wasm`, `initramfs.cpio.gz`, the browser
runtime/worker and a manifest carrying the checkpoint generation and checksum.

Selecting NERU from mikuOS performs this ahead-of-time build before CLI boot.
A web deployment performs the same build during asset generation. CLI and web
consume the same kernel and initramfs artefacts; only their host adapters
differ.

## Boot policy

NERU compares the image generation with the authoritative filesystem
generation and mounts the live state over the immutable base. If the authority
is unavailable, the default is to fail clearly rather than create a divergent
writable installation. Read-only checkpoint and recovery modes must be chosen
explicitly.

NEMUNEMU owns THX loading, Thistle execution and ABI translation. NERU owns the
Linux-visible shared mount so native Linux-WASM and THX processes see the same
persistent files. `uname` inside the guest reports the actual Linux release.
