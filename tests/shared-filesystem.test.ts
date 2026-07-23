import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthoritativeFilesystem, MemoryPersistence } from "../src/fs/core.js";
import { NodeJournalPersistence } from "../src/fs/node-persistence.js";
import { NodeCheckpointStore } from "../src/fs/checkpoint.js";
import { decideSharedBoot } from "../src/fs/boot-policy.js";
import { FetchSharedFsClient } from "../src/fs/client.js";
import { SharedFsHttpServer } from "../src/fs/server.js";
import { SHARED_FS_SCHEMA, SharedFsError, decodeBytes, encodeBytes } from "../src/fs/protocol.js";
import type { SharedOperation } from "../src/fs/protocol.js";

const lease = (fs: AuthoritativeFilesystem, clientId: string) => fs.createLease({ clientId, ttlMs: 60_000 });
const commit = async (fs: AuthoritativeFilesystem, clientId: string, leaseId: string, baseGeneration: number, operations: SharedOperation[]) =>
  fs.commit({ schema: SHARED_FS_SCHEMA, transactionId: randomUUID(), clientId, leaseId, baseGeneration, operations });
const setup = async () => {
  const fs = await AuthoritativeFilesystem.open(new MemoryPersistence(), { filesystemId: "test-fs" });
  const active = lease(fs, "bootstrap");
  await commit(fs, "bootstrap", active.leaseId, 0, [
    { op: "mkdir", path: "/home", mode: 0o755, uid: 0, gid: 0 },
    { op: "mkdir", path: "/home/guest", mode: 0o755, uid: 1000, gid: 1000 },
    { op: "mkdir", path: "/etc", mode: 0o755, uid: 0, gid: 0 },
    { op: "mkdir", path: "/usr", mode: 0o755, uid: 0, gid: 0 },
    { op: "mkdir", path: "/opt", mode: 0o755, uid: 0, gid: 0 },
    { op: "mkdir", path: "/root", mode: 0o700, uid: 0, gid: 0 },
    { op: "mkdir", path: "/var", mode: 0o755, uid: 0, gid: 0 },
  ]);
  return fs;
};
const text = (fs: AuthoritativeFilesystem, path: string): string => {
  const entry = fs.snapshot().entries.find(item => item.path === path);
  assert.ok(entry, `missing ${path}`);
  return new TextDecoder().decode(decodeBytes(entry.data));
};

test("1-2: Teto writes are visible to NERU and NERU writes are visible to Teto", async () => {
  const fs = await setup();
  const teto = lease(fs, "teto");
  const neru = lease(fs, "neru");
  const start = fs.snapshot();
  await commit(fs, "teto", teto.leaseId, start.generation, [
    { op: "create", path: "/home/guest/shared", kind: "file", mode: 0o644, uid: 1000, gid: 1000, data: encodeBytes(new TextEncoder().encode("teto")) },
  ]);
  assert.equal(text(fs, "/home/guest/shared"), "teto");
  const entry = fs.snapshot().entries.find(item => item.path === "/home/guest/shared")!;
  await commit(fs, "neru", neru.leaseId, start.generation, [
    { op: "write", path: entry.path, offset: 0, truncate: true, expectedVersion: entry.version, data: encodeBytes(new TextEncoder().encode("neru")) },
  ]);
  assert.equal(text(fs, entry.path), "neru");
});

test("3 and 5: concurrent independent files succeed and same-file stale writes conflict", async () => {
  const fs = await setup();
  const left = lease(fs, "left");
  const right = lease(fs, "right");
  const base = fs.snapshot().generation;
  await commit(fs, "left", left.leaseId, base, [{ op: "create", path: "/home/guest/left", kind: "file", mode: 0o644, uid: 1000, gid: 1000, data: encodeBytes(new TextEncoder().encode("L")) }]);
  await commit(fs, "right", right.leaseId, base, [{ op: "create", path: "/home/guest/right", kind: "file", mode: 0o644, uid: 1000, gid: 1000, data: encodeBytes(new TextEncoder().encode("R")) }]);
  const inode = fs.snapshot().entries.find(entry => entry.path === "/home/guest/left")!;
  await commit(fs, "left", left.leaseId, fs.snapshot().generation, [{ op: "write", path: inode.path, offset: 0, truncate: true, expectedVersion: inode.version, data: encodeBytes(new TextEncoder().encode("new")) }]);
  await assert.rejects(
    commit(fs, "right", right.leaseId, base, [{ op: "write", path: inode.path, offset: 0, truncate: true, expectedVersion: inode.version, data: encodeBytes(new TextEncoder().encode("lost")) }]),
    (error: unknown) => error instanceof SharedFsError && error.code === "ESTALE",
  );
  assert.equal(text(fs, inode.path), "new");
});

test("4: rename publishes one atomic directory generation", async () => {
  const fs = await setup();
  const client = lease(fs, "rename");
  await commit(fs, "rename", client.leaseId, fs.snapshot().generation, [{ op: "create", path: "/etc/old", kind: "file", mode: 0o644, uid: 0, gid: 0, data: encodeBytes(new TextEncoder().encode("config")) }]);
  const before = fs.snapshot().entries.find(entry => entry.path === "/etc/old")!;
  const watched = fs.watch(fs.snapshot().generation, 5_000);
  await commit(fs, "rename", client.leaseId, fs.snapshot().generation, [{ op: "rename", from: "/etc/old", to: "/etc/new", expectedVersion: before.version, expectedTargetVersion: null }]);
  const after = await watched;
  assert.equal(after?.entries.some(entry => entry.path === "/etc/old"), false);
  assert.equal(after?.entries.some(entry => entry.path === "/etc/new"), true);
});

test("6: a crash during write recovers the last committed version", async () => {
  const root = await mkdtemp(join(tmpdir(), "nerufs-journal-"));
  try {
    const fs = await AuthoritativeFilesystem.open(new NodeJournalPersistence(root), { filesystemId: "durable" });
    const writer = lease(fs, "writer");
    await commit(fs, "writer", writer.leaseId, 0, [{ op: "mkdir", path: "/etc", mode: 0o755, uid: 0, gid: 0 }]);
    const crashing = await AuthoritativeFilesystem.open(new NodeJournalPersistence(root, { crashAt: "after-manifest" }));
    const crashLease = lease(crashing, "crash");
    await assert.rejects(commit(crashing, "crash", crashLease.leaseId, 1, [{ op: "create", path: "/etc/partial", kind: "file", mode: 0o644, uid: 0, gid: 0, data: encodeBytes(new TextEncoder().encode("partial")) }]));
    const recovered = await AuthoritativeFilesystem.open(new NodeJournalPersistence(root));
    assert.equal(recovered.snapshot().generation, 1);
    assert.equal(recovered.snapshot().entries.some(entry => entry.path === "/etc/partial"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("7: failed checkpoint generation preserves the selected checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "nerufs-checkpoint-"));
  try {
    const checkpoints = new NodeCheckpointStore(root);
    const first = await checkpoints.publish(4, async directory => { await writeFile(join(directory, "image"), "good"); return { checksum: "good" }; }, async (directory, checksum) => assert.equal(await readFile(join(directory, "image"), "utf8"), checksum));
    await assert.rejects(checkpoints.publish(5, async directory => { await writeFile(join(directory, "image"), "bad"); return { checksum: "bad" }; }, async () => {}, { beforePublish: () => { throw new Error("power loss"); } }));
    assert.deepEqual(await checkpoints.selected(), first);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("8 and 10: old images attach newer generations and missing authority never forks", async () => {
  const fs = await setup();
  const decision = decideSharedBoot(0, fs.snapshot());
  assert.equal(decision.mode, "shared");
  assert.ok(decision.generation > decision.baseGeneration);
  assert.throws(() => decideSharedBoot(0, null, "fail"), /refusing to create a divergent/);
  assert.equal(decideSharedBoot(0, null, "read-only-checkpoint").readOnly, true);
});

test("9: kernel-local roots never enter the shared generation", async () => {
  const fs = await setup();
  const client = lease(fs, "kernel-local");
  for (const path of ["/dev/x", "/proc/x", "/sys/x", "/run/x", "/tmp/x"]) {
    await assert.rejects(commit(fs, "kernel-local", client.leaseId, fs.snapshot().generation, [{ op: "create", path, kind: "file", mode: 0o600, uid: 0, gid: 0, data: "" }]), (error: unknown) => error instanceof SharedFsError && error.code === "EROFS");
  }
});

test("11: native Linux and THX clients see one mounted persistent namespace", async () => {
  const fs = await setup();
  const server = await new SharedFsHttpServer(fs).listen();
  const native = new FetchSharedFsClient(server.url, { clientId: "native-linux" });
  const thx = new FetchSharedFsClient(server.url, { clientId: "thx" });
  try {
    const base = await native.snapshot();
    await native.commit([{ op: "create", path: "/opt/native", kind: "file", mode: 0o644, uid: 0, gid: 0, data: encodeBytes(new TextEncoder().encode("native")) }], base.generation);
    const seen = await thx.snapshot();
    assert.equal(new TextDecoder().decode(decodeBytes(seen.entries.find(entry => entry.path === "/opt/native")!.data)), "native");
  } finally { await server.close(); }
});

test("12: separate remote clients coordinate through one durable authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "nerufs-remote-"));
  try {
    const fs = await AuthoritativeFilesystem.open(new NodeJournalPersistence(root));
    await fs.seed((await setup()).snapshot());
    const server = await new SharedFsHttpServer(fs).listen();
    const first = new FetchSharedFsClient(server.url, { clientId: "web-a" });
    const second = new FetchSharedFsClient(server.url, { clientId: "web-b" });
    try {
      const base = await first.snapshot();
      await first.commit([{ op: "create", path: "/var/remote", kind: "file", mode: 0o644, uid: 0, gid: 0, data: encodeBytes(new TextEncoder().encode("durable")) }], base.generation);
      const seen = await second.snapshot();
      assert.equal(new TextDecoder().decode(decodeBytes(seen.entries.find(entry => entry.path === "/var/remote")!.data)), "durable");
    } finally { await server.close(); }
    const reopened = await AuthoritativeFilesystem.open(new NodeJournalPersistence(root));
    assert.equal(text(reopened, "/var/remote"), "durable");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("expired leases recover abandoned advisory locks", async () => {
  let clock = 1_000;
  const fs = await AuthoritativeFilesystem.open(new MemoryPersistence(), { clock: () => clock });
  const first = fs.createLease({ clientId: "first", ttlMs: 1_000 });
  fs.acquireLock({ path: "/etc", leaseId: first.leaseId, owner: "first", exclusive: true, ttlMs: 1_000 });
  const second = fs.createLease({ clientId: "second", ttlMs: 10_000 });
  assert.throws(() => fs.acquireLock({ path: "/etc", leaseId: second.leaseId, owner: "second", exclusive: true }), SharedFsError);
  clock += 1_001;
  assert.doesNotThrow(() => fs.acquireLock({ path: "/etc", leaseId: second.leaseId, owner: "second", exclusive: true }));
});
