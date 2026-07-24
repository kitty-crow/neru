# Authoritative shared mikuOS userspace

mikuOS has exactly one authoritative persistent userspace. Thistle, Teto and
NERU/Linux are clients of the same operation-level filesystem service.

NERU now boots a fixed Linux runtime and mounts that userspace live. It does
not normally copy the mikuOS installation into an initramfs or create a second
writable system.

```text
                   authoritative userspace service
                      generation + transaction log
                    /              |               \
             Thistle Tree      Teto Tree       NERU bridge
                                                   |
                                             Linux mikuosfs
                                                   |
                                        NEMUNEMU + native Linux
```

The shared roots are `/etc`, `/home`, `/opt`, `/root`, `/usr`, `/var` and any
other non-runtime paths. `/dev`, `/proc`, `/sys`, `/run` and `/tmp` are local
to the active kernel/session.

## Commit model

Every change is an operation transaction. A durable commit writes an intent,
content-addressed data and metadata, then atomically advances `CURRENT` to a
new monotonically increasing generation. Incomplete generations are ignored
on recovery. Per-inode versions provide conflict detection without rejecting
independent writes made from stale global generations.

Supported operations include create, read/snapshot, write, truncate, rename,
unlink, mkdir/rmdir, chmod, chown, hard link, symlink, fsync and advisory
locks. Leases expire after client loss and release abandoned locks.

## Fixed NERU runtime and live mount

The fixed runtime contains Linux, a minimal initramfs, NEMUNEMU and recovery
tools. It contains no persistent mikuOS userspace.

At boot, the host runtime connects to the selected authoritative filesystem and
exposes its operation protocol to the Linux guest. The Linux `mikuosfs` bridge
mounts the persistent tree at `/mikuos`. NEMUNEMU and native Linux-WASM
processes traverse the same mount.

If the authority is unavailable, the default policy is to fail clearly rather
than create a divergent writable installation. A recovery shell may be offered,
but it must not masquerade as the user's persistent system.

## Local and remote hosts

The Node/Bun daemon uses a journaled object store and HTTP coordination API.
CLI kernels on one host may share one local daemon. Browser and remote clients
use the same API through an authoritative endpoint. A browser-private OPFS
store is not presented as cross-client shared state.

For local execution, the guest bridge should use shared memory and atomics
between Linux-WASM and the host worker. HTTP remains the authority protocol,
not the per-read transport inside one process.

## Proof-of-concept image

The original implementation packaged a copy of `.thistle.base` into an
initramfs. That path proved the Linux-WASM toolchain, NEMUNEMU packaging and
real-kernel boot flow. It remains available only through the explicit
`--poc-image` option for regression testing.

It is not the production persistence design and must never be treated as a
second writable mikuOS installation.

## Recovery and checkpoints

A fixed runtime release may be checksummed and cached independently of user
data. Filesystem checkpoints target one committed authority generation,
verify all objects, fsync them and atomically replace the selected checkpoint
reference. A failed checkpoint leaves the previous reference selected and the
live userspace available.
