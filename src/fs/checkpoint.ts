import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface CheckpointReference {
  schema: 1;
  generation: number;
  path: string;
  checksum: string;
  createdAt: string;
}

export interface CheckpointHooks {
  afterBuild?: () => void | Promise<void>;
  afterVerify?: () => void | Promise<void>;
  beforePublish?: () => void | Promise<void>;
}

const atomicText = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, text);
  await rename(temporary, path);
};

export class NodeCheckpointStore {
  readonly checkpoints: string;
  readonly current: string;
  constructor(readonly root: string) {
    this.checkpoints = join(root, "checkpoints");
    this.current = join(root, "CHECKPOINT");
  }

  async selected(): Promise<CheckpointReference | null> {
    try {
      const value = JSON.parse(await readFile(this.current, "utf8")) as CheckpointReference;
      await stat(value.path);
      return value.schema === 1 ? value : null;
    } catch {
      return null;
    }
  }

  async publish(
    generation: number,
    build: (directory: string) => Promise<{ checksum: string }>,
    verify: (directory: string, checksum: string) => Promise<void>,
    hooks: CheckpointHooks = {},
  ): Promise<CheckpointReference> {
    await mkdir(this.checkpoints, { recursive: true });
    const temporary = join(this.checkpoints, `.building-${generation}-${randomUUID()}`);
    const final = join(this.checkpoints, `${String(generation).padStart(20, "0")}-${randomUUID()}`);
    await mkdir(temporary, { recursive: false });
    try {
      const built = await build(temporary);
      await hooks.afterBuild?.();
      await verify(temporary, built.checksum);
      await hooks.afterVerify?.();
      await rename(temporary, final);
      const reference: CheckpointReference = {
        schema: 1,
        generation,
        path: final,
        checksum: built.checksum,
        createdAt: new Date().toISOString(),
      };
      await hooks.beforePublish?.();
      await atomicText(this.current, `${JSON.stringify(reference, null, 2)}\n`);
      return reference;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
}
