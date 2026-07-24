import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SHARED_FS_SCHEMA } from "./protocol.js";
import type { SharedKind } from "./protocol.js";
import { cloneState } from "./core.js";
import type { CommitIntent, SharedPersistence, StoredInode, StoredState } from "./core.js";

interface ManifestInode {
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
  blob?: string;
  target?: string;
}

interface StateManifest {
  schema: typeof SHARED_FS_SCHEMA;
  filesystemId: string;
  generation: number;
  imageGeneration: number;
  committedAt: string;
  nextInode: number;
  paths: Array<[string, string]>;
  inodes: ManifestInode[];
  checksum: string;
}

export type CommitStage = "after-intent" | "after-blobs" | "after-manifest" | "after-current" | "after-complete";

export interface NodePersistenceOptions {
  crashAt?: CommitStage;
  onStage?: (stage: CommitStage) => void | Promise<void>;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const manifestName = (generation: number): string => `${String(generation).padStart(20, "0")}.json`;

const fsyncFile = async (path: string): Promise<void> => {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
};

const fsyncDirectory = async (path: string): Promise<void> => {
  try {
    const handle = await open(path, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {
    // Some hosts do not permit fsync on directories. File-level fsync and atomic rename still apply.
  }
};

const writeAtomic = async (path: string, value: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, value);
  await fsyncFile(temporary);
  await rename(temporary, path);
  await fsyncDirectory(dirname(path));
};

const exists = async (path: string): Promise<boolean> => {
  try { await stat(path); return true; } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
};

export class NodeJournalPersistence implements SharedPersistence {
  readonly generations: string;
  readonly blobs: string;
  readonly journal: string;
  readonly current: string;

  constructor(readonly root: string, private readonly options: NodePersistenceOptions = {}) {
    this.generations = join(root, "generations");
    this.blobs = join(root, "blobs");
    this.journal = join(root, "journal");
    this.current = join(root, "CURRENT");
  }

  async load(): Promise<StoredState | null> {
    await this.prepare();
    const selected = await this.currentGeneration() ?? await this.latestValidGeneration();
    if (selected === null) return null;
    const state = await this.readGeneration(selected);
    if (!state) throw new Error(`shared filesystem generation ${selected} failed validation`);
    if (!(await this.currentGeneration()) || (await this.currentGeneration()) !== selected) {
      await writeAtomic(this.current, json({ schema: 1, generation: selected }));
    }
    return state;
  }

  async commit(intent: CommitIntent, state: StoredState): Promise<void> {
    await this.prepare();
    if (state.generation !== intent.nextGeneration) throw new Error("generation and intent disagree");
    const intentPath = join(this.journal, `${intent.transactionId}.intent.json`);
    const completePath = join(this.journal, `${intent.transactionId}.complete.json`);
    await writeAtomic(intentPath, json({ schema: 1, ...intent }));
    await this.stage("after-intent");

    const manifest = await this.writeBlobsAndManifest(state);
    await this.stage("after-blobs");

    const generationPath = join(this.generations, manifestName(state.generation));
    await writeAtomic(generationPath, json(manifest));
    await this.stage("after-manifest");

    // CURRENT is the commit marker. Before this rename the previous generation remains authoritative.
    await writeAtomic(this.current, json({ schema: 1, generation: state.generation, checksum: manifest.checksum }));
    await this.stage("after-current");

    await writeAtomic(completePath, json({
      schema: 1,
      transactionId: intent.transactionId,
      generation: state.generation,
      completedAt: new Date().toISOString(),
    }));
    await rm(intentPath, { force: true });
    await this.stage("after-complete");
  }

  private async prepare(): Promise<void> {
    await Promise.all([
      mkdir(this.root, { recursive: true }),
      mkdir(this.generations, { recursive: true }),
      mkdir(this.blobs, { recursive: true }),
      mkdir(this.journal, { recursive: true }),
    ]);
    for (const directory of [this.root, this.generations, this.blobs, this.journal]) {
      for (const name of await readdir(directory)) {
        if (name.includes(".tmp-")) await rm(join(directory, name), { recursive: true, force: true });
      }
    }
  }

  private async stage(stage: CommitStage): Promise<void> {
    await this.options.onStage?.(stage);
    if (this.options.crashAt === stage) throw new Error(`simulated crash at ${stage}`);
  }

  private async writeBlobsAndManifest(state: StoredState): Promise<StateManifest> {
    const inodes: ManifestInode[] = [];
    for (const inode of [...state.inodes.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))) {
      let blob: string | undefined;
      if (inode.kind === "file") {
        const data = inode.data ?? new Uint8Array();
        blob = sha256(data);
        const path = join(this.blobs, blob);
        if (!(await exists(path))) await writeAtomic(path, data);
      }
      inodes.push({
        id: inode.id,
        kind: inode.kind,
        mode: inode.mode,
        uid: inode.uid,
        gid: inode.gid,
        atimeMs: inode.atimeMs,
        mtimeMs: inode.mtimeMs,
        ctimeMs: inode.ctimeMs,
        version: inode.version,
        nlink: inode.nlink,
        ...(blob ? { blob } : {}),
        ...(inode.kind === "symlink" ? { target: inode.target ?? "" } : {}),
      });
    }
    const payload = {
      schema: SHARED_FS_SCHEMA,
      filesystemId: state.filesystemId,
      generation: state.generation,
      imageGeneration: state.imageGeneration,
      committedAt: state.committedAt,
      nextInode: state.nextInode,
      paths: [...state.paths.entries()].sort(([a], [b]) => a.localeCompare(b)),
      inodes,
    };
    return { ...payload, checksum: sha256(JSON.stringify(payload)) };
  }

  private async currentGeneration(): Promise<number | null> {
    try {
      const value = JSON.parse(await readFile(this.current, "utf8")) as { schema?: number; generation?: number };
      return value.schema === 1 && Number.isSafeInteger(value.generation) && (value.generation ?? -1) >= 0
        ? value.generation!
        : null;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      return null;
    }
  }

  private async latestValidGeneration(): Promise<number | null> {
    const candidates = (await readdir(this.generations))
      .filter(name => /^\d{20}\.json$/.test(name))
      .map(name => Number(name.slice(0, 20)))
      .sort((a, b) => b - a);
    for (const generation of candidates) if (await this.readGeneration(generation)) return generation;
    return null;
  }

  private async readGeneration(generation: number): Promise<StoredState | null> {
    try {
      const manifest = JSON.parse(
        await readFile(join(this.generations, manifestName(generation)), "utf8"),
      ) as StateManifest;
      const { checksum, ...payload } = manifest;
      if (manifest.schema !== SHARED_FS_SCHEMA || manifest.generation !== generation) return null;
      if (sha256(JSON.stringify(payload)) !== checksum) return null;
      const inodes = new Map<string, StoredInode>();
      for (const inode of manifest.inodes) {
        let data: Uint8Array | undefined;
        if (inode.kind === "file") {
          if (!inode.blob) return null;
          data = Uint8Array.from(await readFile(join(this.blobs, inode.blob)));
          if (sha256(data) !== inode.blob) return null;
        }
        inodes.set(inode.id, {
          id: inode.id,
          kind: inode.kind,
          mode: inode.mode,
          uid: inode.uid,
          gid: inode.gid,
          atimeMs: inode.atimeMs,
          mtimeMs: inode.mtimeMs,
          ctimeMs: inode.ctimeMs,
          version: inode.version,
          nlink: inode.nlink,
          ...(data ? { data } : {}),
          ...(inode.kind === "symlink" ? { target: inode.target ?? "" } : {}),
        });
      }
      const state: StoredState = {
        schema: SHARED_FS_SCHEMA,
        filesystemId: manifest.filesystemId,
        generation: manifest.generation,
        imageGeneration: manifest.imageGeneration,
        committedAt: manifest.committedAt,
        nextInode: manifest.nextInode,
        paths: new Map(manifest.paths),
        inodes,
      };
      return cloneState(state);
    } catch {
      return null;
    }
  }
}
