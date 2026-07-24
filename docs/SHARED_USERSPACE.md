# Authoritative shared mikuOS userspace

mikuOS has exactly one authoritative persistent userspace. Thistle, Teto and
NERU/Linux are clients of the same filesystem authority.

NERU boots the Linux kernel without a launch image. Linux mounts the selected
mikuOS userspace as its root filesystem and executes NEMUNEMU from that root.

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

## No duplicate launch filesystem

The normal NERU artefact contains the kernel and host runtime only. It contains
no initramfs, BusyBox tree, copied `.thistle.base`, embedded NEMUNEMU binary or
persistent user data.

The live root supplies `/etc`, `/home`, `/opt`, `/root`, `/sbin`, `/usr`, `/var`
and the rest of the installed mikuOS system. `/dev`, `/proc`, `/sys`, `/run`
and `/tmp` remain local to the active Linux session.

The expected kernel command line is:

```text
root=mikuos rootfstype=mikuosfs rw init=/sbin/nemunemu
```

If the authority is unavailable, boot fails clearly. NERU must not silently
create an empty or divergent writable root.

## Commit model

Every persistent change is an operation transaction. A durable commit writes
intent, content and metadata, then atomically advances `CURRENT` to a new
monotonically increasing generation. Incomplete generations are ignored on
recovery. Per-inode versions provide conflict detection without rejecting
independent writes made from stale global generations.

Supported operations include create, read/snapshot, write, truncate, rename,
unlink, mkdir/rmdir, chmod, chown, hard link, symlink, fsync and advisory locks.
Leases expire after client loss and release abandoned locks.

## Linux bridge

The Linux kernel requires a built-in `mikuosfs` root driver. Its VFS operations
are forwarded through shared WebAssembly memory to the NERU host worker, which
uses the selected authority.

For local Node/Bun execution the authority must expose the same host root chosen
by mikuOS `--root`. For the browser it must expose the same OPFS-backed tree
selected by Thistle and Teto. Remote clients may use the same transaction
protocol through an authenticated service.

HTTP is an authority and coordination protocol. It is not the intended
per-operation transport between one Linux-WASM instance and its local host
worker. That path should use shared-memory request and completion rings with
Atomics.

## NEMUNEMU

NEMUNEMU lives in the ordinary mikuOS userspace at `/sbin/nemunemu`. Thistle and
Teto may ignore that executable. Linux loads it from the shared root and starts
it as PID 1.

NEMUNEMU owns THX loading, Thistle execution and ABI translation. NERU owns the
Linux root mount and host bridge so NEMUNEMU and native Linux-WASM processes see
the same files.

## Proof-of-concept image

The original implementation packaged `.thistle.base` into an initramfs. That
proved the Linux-WASM compiler, kernel build, NEMUNEMU packaging and real-kernel
boot path. It remains available only through `--poc-image` for regression work.

It is not the production persistence architecture and must never be treated as
a second writable mikuOS installation.
