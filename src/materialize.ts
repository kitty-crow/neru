import { chmod, chown, link, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { decodeBytes, normaliseSharedPath } from "./fs/protocol.js";
import type { SharedEntry, SharedSnapshot } from "./fs/protocol.js";

export interface MaterialisedSnapshot {
  root: string;
  generation: number;
  checksum: string;
  cleanup(): Promise<void>;
}

const hostPath = (root: string, guest: string): string => {
  const path = normaliseSharedPath(guest);
  return path === "/" ? root : join(root, ...path.slice(1).split("/"));
};

const metadata = async (path: string, entry: SharedEntry): Promise<void> => {
  if (entry.kind !== "symlink") {
    await chmod(path, entry.mode & 0o7777);
    try { await chown(path, entry.uid, entry.gid); }
    catch (error) {
      if (!["EPERM", "ENOSYS"].includes((error as { code?: string }).code ?? "")) throw error;
    }
    await utimes(path, entry.atimeMs / 1000, entry.mtimeMs / 1000);
  }
};

export const materialiseSnapshot = async (snapshot: SharedSnapshot): Promise<MaterialisedSnapshot> => {
  const root = await mkdtemp(join(tmpdir(), "neru-checkpoint-"));
  const firstByInode = new Map<string, string>();
  try {
    const directories = snapshot.entries
      .filter(entry => entry.kind === "directory")
      .sort((left, right) => left.path.split("/").length - right.path.split("/").length || left.path.localeCompare(right.path));
    for (const entry of directories) {
      const path = hostPath(root, entry.path);
      await mkdir(path, { recursive: true });
      firstByInode.set(entry.inode, path);
    }

    for (const entry of snapshot.entries.filter(item => item.kind !== "directory")) {
      const path = hostPath(root, entry.path);
      await mkdir(dirname(path), { recursive: true });
      const first = firstByInode.get(entry.inode);
      if (first && entry.kind === "file") {
        await link(first, path);
      } else if (entry.kind === "file") {
        await writeFile(path, decodeBytes(entry.data));
        firstByInode.set(entry.inode, path);
      } else {
        await symlink(entry.target ?? "", path);
        firstByInode.set(entry.inode, path);
      }
    }

    for (const entry of snapshot.entries
      .slice()
      .sort((left, right) => right.path.split("/").length - left.path.split("/").length)) {
      await metadata(hostPath(root, entry.path), entry);
    }

    return {
      root,
      generation: snapshot.generation,
      checksum: snapshot.checksum,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
};
