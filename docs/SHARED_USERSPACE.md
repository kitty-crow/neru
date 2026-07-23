# Authoritative shared mikuOS userspace

mikuOS has exactly one authoritative persistent userspace. Thistle, Teto and
NERU/Linux are clients of the same operation-level filesystem service.
NERU's prebuilt image is an immutable boot base and checkpoint; it is never a
second writable installation.

```text
                   authoritative userspace service
                      generation + transaction log
                    /              |               \
             Thistle Tree      Teto Tree       NERU mount
                                                /       \
                                          NEMUNEMU   native Linux
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

## NERU image and mount

An image manifest carries the checkpoint generation and checksum. At boot,
NERU attaches the authoritative service and compares its generation with the
image generation. The image contributes Linux, initramfs, NEMUNEMU and a
read-only recovery base. Persistent paths come from the live mount.

The Linux mount uses the same bridge protocol as the mikuOS `Tree` clients.
The bridge belongs to NERU rather than NEMUNEMU so native Linux-WASM and THX
processes traverse the same mount. If the authority is unavailable, the
default policy is to fail boot. Read-only checkpoint and recovery modes must
be selected explicitly.

## Local and remote hosts

The Node/Bun daemon uses a journaled object store and HTTP coordination API.
CLI kernels on one host may share one local daemon. Browser and remote clients
use the same API through an authoritative endpoint. A browser-private OPFS
store is not presented as cross-client shared state.

## Checkpoints

Checkpoint construction targets one committed generation, verifies all
artifacts, fsyncs them and atomically replaces the selected checkpoint
reference. A failed build leaves the previous checkpoint selected and the
live userspace remains available.
