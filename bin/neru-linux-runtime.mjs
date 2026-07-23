#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { Worker as NodeWorker } from "node:worker_threads";
import { FetchSharedFsClient } from "../dist/src/fs/client.js";
import { NeruLinuxFsBridge } from "../dist/src/fs/linux-bridge.js";

const WORKER_BOOTSTRAP = new URL(
  "../runtime/node-worker-bootstrap.mjs",
  import.meta.url,
);

const args = process.argv.slice(2);
const value = (name) => {
  const joined = args.find((argument) => argument.startsWith(`${name}=`));
  if (joined) return joined.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes("--help")) {
  process.stdout.write(
    "Usage: neru-linux-runtime --kernel PATH --initramfs PATH " +
      "[--runtime PATH] [--worker PATH] [--shared-fs URL] " +
      "[--variant wasm32_nommu|wasm64_nommu] [--cmdline TEXT]\n",
  );
  process.exit(0);
}

const kernelPath = value("--kernel");
const initramfsPath = value("--initramfs");
const variant = value("--variant") ?? process.env.NERU_LINUX_VARIANT ?? "wasm32_nommu";
const sharedEndpoint = value("--shared-fs") ?? process.env.MIKUOS_FS_URL;
const sharedToken = value("--shared-fs-token") ?? process.env.MIKUOS_FS_TOKEN;
const verbose = process.env.NERU_VERBOSE === "1";
if (!kernelPath || !initramfsPath) {
  throw new Error("--kernel and --initramfs are required");
}
if (!sharedEndpoint) {
  throw new Error("NERU requires --shared-fs URL or MIKUOS_FS_URL; refusing a divergent writable boot");
}
if (variant !== "wasm32_nommu" && variant !== "wasm64_nommu") {
  throw new Error(`Unsupported Linux-WASM variant: ${variant}`);
}

const artifactRoot = dirname(resolve(kernelPath));
const runtimePath = resolve(value("--runtime") ?? `${artifactRoot}/linux.js`);
const workerPath = resolve(value("--worker") ?? `${artifactRoot}/linux-worker.js`);

class WorkerAdapter {
  #worker;
  #onmessage;
  #onmessageerror;
  #onerror;

  constructor(url, options = {}) {
    const upstreamWorker = typeof url === "string" && url.startsWith("file:")
      ? fileURLToPath(url)
      : resolve(String(url));
    this.#worker = new NodeWorker(WORKER_BOOTSTRAP, {
      name: options.name,
      workerData: { upstreamWorker },
      type: "module",
    });
    this.#worker.on("message", (data) => this.#onmessage?.({ data }));
    this.#worker.on("messageerror", (error) => this.#onmessageerror?.(error));
    this.#worker.on("error", (error) => {
      if (this.#onerror) this.#onerror(error);
      else throw error;
    });
  }

  set onmessage(handler) { this.#onmessage = handler; }
  set onmessageerror(handler) { this.#onmessageerror = handler; }
  set onerror(handler) { this.#onerror = handler; }
  postMessage(message) { this.#worker.postMessage(message); }
  terminate() { void this.#worker.terminate(); }
}

Object.defineProperty(globalThis, "Worker", {
  configurable: true,
  value: WorkerAdapter,
});
Object.defineProperty(globalThis, "confirm", {
  configurable: true,
  value: () => false,
});

const runtimeSource = await readFile(runtimePath, "utf8");
runInThisContext(
  `${runtimeSource}\n;globalThis.__neruLinux = linux;`,
  { filename: runtimePath },
);
const linux = globalThis.__neruLinux;
delete globalThis.__neruLinux;
if (typeof linux !== "function") {
  throw new Error("NERU Linux-WASM runtime did not expose its Linux launcher");
}

const sharedClient = new FetchSharedFsClient(sharedEndpoint, {
  clientId: `neru-linux-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
  leaseTtlMs: 300_000,
  ...(sharedToken ? { token: sharedToken } : {}),
});
await sharedClient.connect();
const shared = await sharedClient.snapshot();
const fsBridge = new NeruLinuxFsBridge(sharedClient);

const [kernelBytes, initramfsBytes] = await Promise.all([
  readFile(kernelPath),
  readFile(initramfsPath),
]);
const kernel = await WebAssembly.compile(kernelBytes);
const initramfs = initramfsBytes.buffer.slice(
  initramfsBytes.byteOffset,
  initramfsBytes.byteOffset + initramfsBytes.byteLength,
);
const commandLine = value("--cmdline") ??
  "maxcpus=3 nohz_full=0,2-63 rcu_nocbs=0,2-63 " +
  "root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0";

process.stderr.write(
  `neru: booting Linux (${variant}); authoritative userspace generation ${shared.generation}\n`,
);
const machine = await linux(
  workerPath,
  variant,
  kernel,
  commandLine,
  initramfs,
  (message) => {
    if (verbose) process.stderr.write(`neru: ${message}\n`);
  },
  (message) => process.stdout.write(message),
  (request) => fsBridge.call(Uint8Array.from(request)),
);

let raw = false;
const restoreTerminal = () => {
  if (raw && process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    raw = false;
  }
};
const close = async () => {
  restoreTerminal();
  await fsBridge.close().catch(() => undefined);
  await sharedClient.close().catch(() => undefined);
};
process.once("exit", restoreTerminal);
process.once("SIGTERM", () => void close().then(() => process.exit(143)));
process.once("SIGINT", () => machine.key_input("\u0003"));

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  raw = true;
}
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  machine.key_input(Buffer.from(chunk).toString("utf8"));
});
