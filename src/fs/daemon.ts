import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AuthoritativeFilesystem } from "./core.js";
import { NodeJournalPersistence } from "./node-persistence.js";
import type { SharedSnapshot } from "./protocol.js";
import { SharedFsHttpServer } from "./server.js";

export interface SharedFsDaemonOptions {
  store: string;
  hostname?: string;
  port?: number;
  token?: string;
  seed?: SharedSnapshot | string;
}

export interface SharedFsDaemon {
  readonly filesystem: AuthoritativeFilesystem;
  readonly url: URL;
  close(): Promise<void>;
}

const readSeed = async (seed: SharedSnapshot | string | undefined): Promise<SharedSnapshot | undefined> => {
  if (!seed) return undefined;
  if (typeof seed !== "string") return seed;
  return JSON.parse(await readFile(resolve(seed), "utf8")) as SharedSnapshot;
};

export const startSharedFsDaemon = async (options: SharedFsDaemonOptions): Promise<SharedFsDaemon> => {
  const store = resolve(options.store);
  await mkdir(store, { recursive: true });
  const filesystem = await AuthoritativeFilesystem.open(new NodeJournalPersistence(store));
  const seed = await readSeed(options.seed);
  if (seed) await filesystem.seed(seed);
  const server = new SharedFsHttpServer(filesystem, {
    ...(options.hostname ? { hostname: options.hostname } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.token ? { token: options.token } : {}),
  });
  const listening = await server.listen();
  return { filesystem, url: listening.url, close: listening.close };
};
