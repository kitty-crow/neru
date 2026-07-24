# Architecture

NERU is the ahead-of-time image builder and Linux kernel-integration layer
for Thistle systems.

```text
same mikuOS userland root
          |
          | NERU build (Bun/Node/Python/shell)
          v
Linux kernel + deterministic initramfs
          |
          v
NEMUNEMU compatibility layer
          |
          v
same packaged mikuOS command and THX contracts
```

## Ownership

NERU owns:

- the pinned Linux-WASM source and toolchain integration;
- conversion of a mikuOS userland root into a Linux-bootable packaged copy;
- installation of NEMUNEMU and BusyBox compatibility support;
- deterministic initramfs construction;
- the shared kernel/initramfs artefacts;
- terminal and browser host adapters.

NEMUNEMU owns:

- THX1 and THX2 execution;
- the Thistle-to-Linux syscall ABI;
- compatibility for packaged `#!thistle:<command>` contracts;
- entry into the packaged userland root.

mikuOS owns the userland. It may select NERU, but it does not maintain a
second NERU-specific shell, filesystem or command implementation.

## Ahead-of-time boundary

`bun neru.ts --userland ROOT` builds the image before Linux starts. The
runtime receives only `vmlinux.wasm` and `initramfs.cpio.gz`; no live source
path or host mikuOS callback crosses the boot boundary.

The browser loads the same artefacts generated during the web build. It does
not compile the userland after page load.

`uname` inside NERU is the real Linux `uname` and reports the actual built
kernel release.
