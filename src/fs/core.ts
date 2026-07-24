import { randomUUID } from "node:crypto";
import {
  SHARED_FS_SCHEMA,
  SharedFsError,
  decodeBytes,
  encodeBytes,
  isKernelLocalPath,
  isPersistentPath,
  normaliseSharedPath,
} from "./protocol.js";
import type {
  AdvisoryLock,
  Lease,
  LeaseRequest,
  LockRequest,
  SharedCommitResult,
  SharedEntry,
  SharedKind,
  SharedOperation,
  SharedSnapshot,
  SharedTransaction,
} from "./protocol.js";

export interface StoredInode {
  id: string;
  kind: SharedKind;
  mode: number;
  uid: number;
  gid: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  version: number;
  nlink: number;
  data?: Uint8Array;
  target?: string;
}

export interface StoredState {
  schema: typeof SHARED_FS_SCHEMA;
  filesystemId: string;
  generation: number;
  imageGeneration: number;
  committedAt: string;
  nextInode: number;
  paths: Map<string, string>;
  inodes: Map<string, StoredInode>;
}

export interface CommitIntent {
  transactionId: string;
  clientId: string;
  leaseId: string;
  previousGeneration: number;
  nextGeneration: number;
  operations: SharedOperation[];
  createdAt: string;
}

export interface SharedPersistence {
  load(): Promise<StoredState | null>;
  commit(intent: CommitIntent, state: StoredState): Promise<void>;
}

const now = (): number => Date.now();
const parentPath = (path: string): string => {
  if (path === "/") return "/";
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
};

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
};

const fnv = (value: string): string => {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const dataChecksum = (bytes: Uint8Array): string => {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${bytes.length}:${(hash >>> 0).toString(16)}`;
};

const cloneInode = (inode: StoredInode): StoredInode => ({
  ...inode,
  ...(inode.data ? { data: Uint8Array.from(inode.data) } : {}),
});

export const cloneState = (state: StoredState): StoredState => ({
  ...state,
  paths: new Map(state.paths),
  inodes: new Map([...state.inodes].map(([id, inode]) => [id, cloneInode(inode)])),
});

export const initialState = (filesystemId: string = randomUUID()): StoredState => {
  const timestamp = now();
  const root: StoredInode = {
    id: "1",
    kind: "directory",
    mode: 0o755,
    uid: 0,
    gid: 0,
    atimeMs: timestamp,
    mtimeMs: timestamp,
    ctimeMs: timestamp,
    version: 1,
    nlink: 1,
  };
  return {
    schema: SHARED_FS_SCHEMA,
    filesystemId,
    generation: 0,
    imageGeneration: 0,
    committedAt: new Date(timestamp).toISOString(),
    nextInode: 2,
    paths: new Map([["/", root.id]]),
    inodes: new Map([[root.id, root]]),
  };
};

export class MemoryPersistence implements SharedPersistence {
  private state: StoredState | null;
  constructor(seed?: StoredState) {
    this.state = seed ? cloneState(seed) : null;
  }
  async load(): Promise<StoredState | null> {
    return this.state ? cloneState(this.state) : null;
  }
  async commit(_intent: CommitIntent, state: StoredState): Promise<void> {
    this.state = cloneState(state);
  }
}

const entryFor = (state: StoredState, path: string): SharedEntry => {
  const inodeId = state.paths.get(path);
  if (!inodeId) throw new SharedFsError("ENOENT", path);
  const inode = state.inodes.get(inodeId);
  if (!inode) throw new Error(`missing inode ${inodeId}`);
  const base: SharedEntry = {
    path,
    inode: inode.id,
    kind: inode.kind,
    mode: inode.mode,
    uid: inode.uid,
    gid: inode.gid,
    atimeMs: inode.atimeMs,
    mtimeMs: inode.mtimeMs,
    ctimeMs: inode.ctimeMs,
    version: inode.version,
    nlink: inode.nlink,
  };
  if (inode.kind === "file") {
    const data = inode.data ?? new Uint8Array();
    base.size = data.length;
    base.checksum = dataChecksum(data);
    base.data = encodeBytes(data);
  } else if (inode.kind === "symlink") {
    base.target = inode.target ?? "";
  }
  return base;
};

export const snapshotState = (state: StoredState): SharedSnapshot => {
  const entries = [...state.paths.keys()]
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .map(path => entryFor(state, path));
  const payload = {
    schema: SHARED_FS_SCHEMA,
    filesystemId: state.filesystemId,
    generation: state.generation,
    imageGeneration: state.imageGeneration,
    committedAt: state.committedAt,
    entries,
  };
  return { ...payload, checksum: fnv(canonical(payload)) };
};

export const stateFromSnapshot = (snapshot: SharedSnapshot): StoredState => {
  if (snapshot.schema !== SHARED_FS_SCHEMA) throw new SharedFsError("EINVAL", "unsupported shared filesystem schema");
  const paths = new Map<string, string>();
  const inodes = new Map<string, StoredInode>();
  let nextInode = 1;
  for (const entry of snapshot.entries) {
    const path = normaliseSharedPath(entry.path);
    paths.set(path, entry.inode);
    const numeric = Number(entry.inode);
    if (Number.isSafeInteger(numeric)) nextInode = Math.max(nextInode, numeric + 1);
    if (inodes.has(entry.inode)) continue;
    inodes.set(entry.inode, {
      id: entry.inode,
      kind: entry.kind,
      mode: entry.mode,
      uid: entry.uid,
      gid: entry.gid,
      atimeMs: entry.atimeMs,
      mtimeMs: entry.mtimeMs,
      ctimeMs: entry.ctimeMs,
      version: entry.version,
      nlink: entry.nlink,
      ...(entry.kind === "file" ? { data: decodeBytes(entry.data) } : {}),
      ...(entry.kind === "symlink" ? { target: entry.target ?? "" } : {}),
    });
  }
  if (!paths.has("/")) throw new SharedFsError("EINVAL", "snapshot has no root directory");
  return {
    schema: SHARED_FS_SCHEMA,
    filesystemId: snapshot.filesystemId,
    generation: snapshot.generation,
    imageGeneration: snapshot.imageGeneration,
    committedAt: snapshot.committedAt,
    nextInode,
    paths,
    inodes,
  };
};

interface Watcher {
  after: number;
  resolve(snapshot: SharedSnapshot | null): void;
  timer: ReturnType<typeof setTimeout>;
}

export class AuthoritativeFilesystem {
  private state: StoredState;
  private readonly leases = new Map<string, Lease>();
  private readonly locks = new Map<string, AdvisoryLock>();
  private readonly watchers = new Set<Watcher>();
  private serial = Promise.resolve();

  private constructor(
    private readonly persistence: SharedPersistence,
    state: StoredState,
    private readonly clock: () => number,
  ) {
    this.state = state;
  }

  static async open(
    persistence: SharedPersistence = new MemoryPersistence(),
    options: { filesystemId?: string; clock?: () => number } = {},
  ): Promise<AuthoritativeFilesystem> {
    const state = await persistence.load() ?? initialState(options.filesystemId);
    return new AuthoritativeFilesystem(persistence, state, options.clock ?? now);
  }

  snapshot(): SharedSnapshot {
    return snapshotState(this.state);
  }

  async seed(snapshot: SharedSnapshot): Promise<SharedSnapshot> {
    return await this.exclusive(async () => {
      if (this.state.generation !== 0 || this.state.paths.size !== 1) return this.snapshot();
      const next = stateFromSnapshot(snapshot);
      next.generation = Math.max(1, snapshot.generation);
      next.committedAt = new Date(this.clock()).toISOString();
      const intent: CommitIntent = {
        transactionId: `seed-${randomUUID()}`,
        clientId: "seed",
        leaseId: "seed",
        previousGeneration: 0,
        nextGeneration: next.generation,
        operations: [],
        createdAt: next.committedAt,
      };
      await this.persistence.commit(intent, next);
      this.state = next;
      this.notify();
      return this.snapshot();
    });
  }

  createLease(request: LeaseRequest): Lease {
    this.recoverExpired();
    if (!request.clientId) throw new SharedFsError("EINVAL", "clientId is required");
    const ttlMs = Math.max(1_000, Math.min(request.ttlMs ?? 30_000, 300_000));
    const lease: Lease = {
      leaseId: randomUUID(),
      clientId: request.clientId,
      expiresAt: this.clock() + ttlMs,
    };
    this.leases.set(lease.leaseId, lease);
    return { ...lease };
  }

  heartbeat(leaseId: string, ttlMs = 30_000): Lease {
    this.recoverExpired();
    const lease = this.leases.get(leaseId);
    if (!lease) throw new SharedFsError("ESTALE", "lease expired");
    lease.expiresAt = this.clock() + Math.max(1_000, Math.min(ttlMs, 300_000));
    return { ...lease };
  }

  releaseLease(leaseId: string): void {
    this.leases.delete(leaseId);
    for (const [id, lock] of this.locks) if (lock.leaseId === leaseId) this.locks.delete(id);
  }

  acquireLock(request: LockRequest): AdvisoryLock {
    this.recoverExpired();
    this.requireLease(request.leaseId);
    const path = normaliseSharedPath(request.path);
    const conflicts = [...this.locks.values()].filter(lock =>
      lock.path === path && lock.leaseId !== request.leaseId && (lock.exclusive || request.exclusive)
    );
    if (conflicts.length) throw new SharedFsError("ELOCKED", `${path}: advisory lock is held`);
    const lock: AdvisoryLock = {
      ...request,
      path,
      lockId: randomUUID(),
      expiresAt: this.clock() + Math.max(1_000, Math.min(request.ttlMs ?? 30_000, 300_000)),
    };
    this.locks.set(lock.lockId, lock);
    return { ...lock };
  }

  releaseLock(lockId: string, leaseId: string): void {
    const lock = this.locks.get(lockId);
    if (lock && lock.leaseId === leaseId) this.locks.delete(lockId);
  }

  async watch(after: number, timeoutMs = 30_000): Promise<SharedSnapshot | null> {
    if (this.state.generation > after) return this.snapshot();
    return await new Promise(resolve => {
      const watcher: Watcher = {
        after,
        resolve,
        timer: setTimeout(() => {
          this.watchers.delete(watcher);
          resolve(null);
        }, Math.max(1, Math.min(timeoutMs, 60_000))),
      };
      this.watchers.add(watcher);
    });
  }

  async commit(transaction: SharedTransaction): Promise<SharedCommitResult> {
    return await this.exclusive(async () => {
      if (transaction.schema !== SHARED_FS_SCHEMA) throw new SharedFsError("EINVAL", "unsupported transaction schema");
      const lease = this.requireLease(transaction.leaseId);
      if (lease.clientId !== transaction.clientId) throw new SharedFsError("ESTALE", "lease belongs to another client");
      if (!transaction.transactionId || !Array.isArray(transaction.operations)) throw new SharedFsError("EINVAL", "invalid transaction");
      const next = cloneState(this.state);
      for (const operation of transaction.operations) {
        this.checkLock(transaction, operation);
        this.apply(next, operation);
      }
      const previousGeneration = this.state.generation;
      next.generation = previousGeneration + 1;
      next.imageGeneration = Math.max(next.imageGeneration, transaction.imageGeneration ?? 0);
      next.committedAt = new Date(this.clock()).toISOString();
      const intent: CommitIntent = {
        transactionId: transaction.transactionId,
        clientId: transaction.clientId,
        leaseId: transaction.leaseId,
        previousGeneration,
        nextGeneration: next.generation,
        operations: transaction.operations,
        createdAt: next.committedAt,
      };
      await this.persistence.commit(intent, next);
      this.state = next;
      this.notify();
      return { generation: next.generation, transactionId: transaction.transactionId, snapshot: this.snapshot() };
    });
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const current = this.serial.then(work, work);
    this.serial = current.then(() => undefined, () => undefined);
    return await current;
  }

  private notify(): void {
    for (const watcher of [...this.watchers]) {
      if (this.state.generation <= watcher.after) continue;
      this.watchers.delete(watcher);
      clearTimeout(watcher.timer);
      watcher.resolve(this.snapshot());
    }
  }

  private recoverExpired(): void {
    const timestamp = this.clock();
    const expired = new Set<string>();
    for (const [id, lease] of this.leases) {
      if (lease.expiresAt <= timestamp) {
        this.leases.delete(id);
        expired.add(id);
      }
    }
    for (const [id, lock] of this.locks) {
      if (lock.expiresAt <= timestamp || expired.has(lock.leaseId)) this.locks.delete(id);
    }
  }

  private requireLease(leaseId: string): Lease {
    this.recoverExpired();
    const lease = this.leases.get(leaseId);
    if (!lease) throw new SharedFsError("ESTALE", "lease expired or unknown");
    return lease;
  }

  private checkLock(transaction: SharedTransaction, operation: SharedOperation): void {
    const paths = operation.op === "rename"
      ? [operation.from, operation.to]
      : operation.op === "link"
        ? [operation.from, operation.to]
        : operation.op === "fsync" && !operation.path
          ? []
          : ["path" in operation ? operation.path : "/"];
    for (const raw of paths) {
      const path = normaliseSharedPath(raw);
      for (const lock of this.locks.values()) {
        if (lock.leaseId === transaction.leaseId) continue;
        const overlap = path === lock.path || path.startsWith(`${lock.path}/`) || lock.path.startsWith(`${path}/`);
        if (overlap && lock.exclusive) throw new SharedFsError("ELOCKED", `${path}: locked by ${lock.owner}`);
      }
    }
  }

  private inodeAt(state: StoredState, rawPath: string): StoredInode {
    const path = normaliseSharedPath(rawPath);
    const id = state.paths.get(path);
    const inode = id ? state.inodes.get(id) : undefined;
    if (!inode) throw new SharedFsError("ENOENT", path);
    return inode;
  }

  private assertExpected(path: string, inode: StoredInode | undefined, expected: number | undefined): void {
    if (expected === undefined) return;
    const actual = inode?.version ?? null;
    if (actual !== expected) {
      throw new SharedFsError("ESTALE", `${path}: generation conflict`, {
        path,
        expected,
        actual,
        reason: "inode changed since the client snapshot",
      });
    }
  }

  private requireShared(path: string): string {
    const normal = normaliseSharedPath(path);
    if (isKernelLocalPath(normal)) throw new SharedFsError("EROFS", `${normal}: kernel-local filesystem`);
    if (!isPersistentPath(normal)) throw new SharedFsError("EROFS", `${normal}: session-local filesystem`);
    return normal;
  }

  private requireParent(state: StoredState, path: string): StoredInode {
    const parent = this.inodeAt(state, parentPath(path));
    if (parent.kind !== "directory") throw new SharedFsError("ENOTDIR", parentPath(path));
    return parent;
  }

  private touch(inode: StoredInode, content = false): void {
    const timestamp = this.clock();
    inode.version++;
    inode.ctimeMs = timestamp;
    if (content) inode.mtimeMs = timestamp;
  }

  private touchParent(state: StoredState, path: string): void {
    this.touch(this.inodeAt(state, parentPath(path)), true);
  }

  private allocate(state: StoredState, kind: SharedKind, mode: number, uid: number, gid: number, data?: Uint8Array, target?: string): StoredInode {
    const timestamp = this.clock();
    const inode: StoredInode = {
      id: String(state.nextInode++),
      kind,
      mode: mode & 0o7777,
      uid,
      gid,
      atimeMs: timestamp,
      mtimeMs: timestamp,
      ctimeMs: timestamp,
      version: 1,
      nlink: 1,
      ...(kind === "file" ? { data: data ?? new Uint8Array() } : {}),
      ...(kind === "symlink" ? { target: target ?? "" } : {}),
    };
    state.inodes.set(inode.id, inode);
    return inode;
  }

  private removePath(state: StoredState, path: string): void {
    const id = state.paths.get(path);
    if (!id) return;
    state.paths.delete(path);
    const inode = state.inodes.get(id);
    if (!inode) return;
    inode.nlink--;
    if (inode.nlink <= 0) state.inodes.delete(id);
    else this.touch(inode);
  }

  private apply(state: StoredState, operation: SharedOperation): void {
    switch (operation.op) {
      case "create": {
        const path = this.requireShared(operation.path);
        if (path === "/") throw new SharedFsError("EEXIST", path);
        if (state.paths.has(path)) throw new SharedFsError("EEXIST", path);
        this.requireParent(state, path);
        if (operation.kind === "symlink" && operation.target === undefined) throw new SharedFsError("EINVAL", `${path}: symlink target missing`);
        const inode = this.allocate(state, operation.kind, operation.mode, operation.uid, operation.gid, decodeBytes(operation.data), operation.target);
        state.paths.set(path, inode.id);
        this.touchParent(state, path);
        return;
      }
      case "mkdir": {
        this.apply(state, { op: "create", path: operation.path, kind: "directory", mode: operation.mode, uid: operation.uid, gid: operation.gid });
        return;
      }
      case "symlink": {
        this.apply(state, { op: "create", path: operation.path, kind: "symlink", mode: operation.mode ?? 0o777, uid: operation.uid ?? 0, gid: operation.gid ?? 0, target: operation.target });
        return;
      }
      case "write": {
        const path = this.requireShared(operation.path);
        const inode = this.inodeAt(state, path);
        this.assertExpected(path, inode, operation.expectedVersion);
        if (inode.kind === "directory") throw new SharedFsError("EISDIR", path);
        if (inode.kind !== "file") throw new SharedFsError("EINVAL", `${path}: not a regular file`);
        if (!Number.isSafeInteger(operation.offset) || operation.offset < 0) throw new SharedFsError("EINVAL", `${path}: invalid write offset`);
        const input = decodeBytes(operation.data);
        const old = operation.truncate ? new Uint8Array() : inode.data ?? new Uint8Array();
        const length = Math.max(old.length, operation.offset + input.length);
        const output = new Uint8Array(length);
        output.set(old.subarray(0, Math.min(old.length, output.length)));
        output.set(input, operation.offset);
        inode.data = output;
        this.touch(inode, true);
        return;
      }
      case "truncate": {
        const path = this.requireShared(operation.path);
        const inode = this.inodeAt(state, path);
        this.assertExpected(path, inode, operation.expectedVersion);
        if (inode.kind !== "file") throw new SharedFsError(inode.kind === "directory" ? "EISDIR" : "EINVAL", path);
        if (!Number.isSafeInteger(operation.size) || operation.size < 0) throw new SharedFsError("EINVAL", `${path}: invalid size`);
        const next = new Uint8Array(operation.size);
        next.set((inode.data ?? new Uint8Array()).subarray(0, operation.size));
        inode.data = next;
        this.touch(inode, true);
        return;
      }
      case "chmod": {
        const path = this.requireShared(operation.path);
        const inode = this.inodeAt(state, path);
        this.assertExpected(path, inode, operation.expectedVersion);
        inode.mode = operation.mode & 0o7777;
        this.touch(inode);
        return;
      }
      case "chown": {
        const path = this.requireShared(operation.path);
        const inode = this.inodeAt(state, path);
        this.assertExpected(path, inode, operation.expectedVersion);
        inode.uid = operation.uid;
        inode.gid = operation.gid;
        this.touch(inode);
        return;
      }
      case "link": {
        const from = this.requireShared(operation.from);
        const to = this.requireShared(operation.to);
        const inode = this.inodeAt(state, from);
        this.assertExpected(from, inode, operation.expectedVersion);
        if (inode.kind === "directory") throw new SharedFsError("EISDIR", from);
        if (state.paths.has(to)) throw new SharedFsError("EEXIST", to);
        this.requireParent(state, to);
        state.paths.set(to, inode.id);
        inode.nlink++;
        this.touch(inode);
        this.touchParent(state, to);
        return;
      }
      case "unlink": {
        const path = this.requireShared(operation.path);
        if (path === "/") throw new SharedFsError("EINVAL", "cannot unlink root");
        const inode = this.inodeAt(state, path);
        this.assertExpected(path, inode, operation.expectedVersion);
        if (inode.kind === "directory") throw new SharedFsError("EISDIR", path);
        this.removePath(state, path);
        this.touchParent(state, path);
        return;
      }
      case "rmdir": {
        const path = this.requireShared(operation.path);
        if (path === "/") throw new SharedFsError("EINVAL", "cannot remove root");
        const inode = this.inodeAt(state, path);
        this.assertExpected(path, inode, operation.expectedVersion);
        if (inode.kind !== "directory") throw new SharedFsError("ENOTDIR", path);
        if ([...state.paths.keys()].some(other => other.startsWith(`${path}/`))) throw new SharedFsError("ENOTEMPTY", path);
        this.removePath(state, path);
        this.touchParent(state, path);
        return;
      }
      case "rename": {
        const from = this.requireShared(operation.from);
        const to = this.requireShared(operation.to);
        if (from === "/" || to === "/") throw new SharedFsError("EINVAL", "cannot rename root");
        if (to.startsWith(`${from}/`)) throw new SharedFsError("EINVAL", "cannot move a directory inside itself");
        const source = this.inodeAt(state, from);
        this.assertExpected(from, source, operation.expectedVersion);
        this.requireParent(state, to);
        const targetId = state.paths.get(to);
        const target = targetId ? state.inodes.get(targetId) : undefined;
        const expectedTarget = operation.expectedTargetVersion;
        if (expectedTarget !== undefined) {
          const actual = target?.version ?? null;
          if (actual !== expectedTarget) throw new SharedFsError("ESTALE", `${to}: target generation conflict`, { path: to, expected: expectedTarget, actual, reason: "rename target changed" });
        }
        if (target) {
          if (target.kind === "directory" && [...state.paths.keys()].some(path => path.startsWith(`${to}/`))) throw new SharedFsError("ENOTEMPTY", to);
          if (source.kind === "directory" && target.kind !== "directory") throw new SharedFsError("ENOTDIR", to);
          if (source.kind !== "directory" && target.kind === "directory") throw new SharedFsError("EISDIR", to);
          this.removePath(state, to);
        }
        const moving = [...state.paths.entries()]
          .filter(([path]) => path === from || path.startsWith(`${from}/`))
          .sort(([a], [b]) => a.length - b.length);
        for (const [path] of moving) state.paths.delete(path);
        for (const [path, id] of moving) state.paths.set(`${to}${path.slice(from.length)}`, id);
        this.touch(source);
        this.touchParent(state, from);
        if (parentPath(from) !== parentPath(to)) this.touchParent(state, to);
        return;
      }
      case "fsync": {
        if (operation.path) {
          const path = this.requireShared(operation.path);
          const inode = this.inodeAt(state, path);
          this.assertExpected(path, inode, operation.expectedVersion);
        }
        return;
      }
    }
  }
}
