#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { Worker as NodeWorker } from "node:worker_threads";

const UPSTREAM_LINUX = fileURLToPath(
  new URL("../vendor/linux-wasm/runtime/linux.js", import.meta.url),
);
const UPSTREAM_WORKER = fileURLToPath(
  new URL("../vendor/linux-wasm/runtime/linux-worker.js", import.meta.url),
);
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
    "Usage: neru-linux-runtime --kernel PATH " +
      "[--initramfs PATH] [--variant wasm32_nommu|wasm64_nommu] [--cmdline TEXT]\n" +
      "\n" +
      "The normal NERU path uses no initramfs. Linux mounts mikuosfs as / and " +
      "executes /sbin/nemunemu from the selected live mikuOS root.\n",
  );
  process.exit(0);
}

const kernelPath = value("--kernel");
const initramfsPath = value("--initramfs");
const variant = value("--variant") ?? process.env.NERU_LINUX_VARIANT ?? "wasm32_nommu";
const verbose = process.env.NERU_VERBOSE === "1";
if (!kernelPath) throw new Error("--kernel is required");
if (variant !== "wasm32_nommu" && variant !== "wasm64_nommu") {
  throw new Error(`Unsupported Linux-WASM variant: ${variant}`);
}

const filesystemRoot = process.env.NERU_FS_ROOT;
const filesystemEndpoint = process.env.NERU_FS_ENDPOINT;
if (!initramfsPath && !filesystemRoot && !filesystemEndpoint) {
  throw new Error(
    "Kernel-only NERU boot requires NERU_FS_ROOT or NERU_FS_ENDPOINT so mikuosfs can mount the live userspace",
  );
}

const filesystem = initramfsPath
  ? null
  : filesystemRoot
    ? {
        kind: "directory",
        root: filesystemRoot,
        clientId: process.env.NERU_FS_CLIENT_ID,
      }
    : {
        kind: "authority",
        endpoint: filesystemEndpoint,
        token: process.env.NERU_FS_TOKEN,
        clientId: process.env.NERU_FS_CLIENT_ID,
      };

class WorkerAdapter {
  #worker;
  #onmessage;
  #onmessageerror;
  #onerror;

  constructor(_url, options = {}) {
    this.#worker = new NodeWorker(WORKER_BOOTSTRAP, {
      name: options.name,
      workerData: {
        upstreamWorker: UPSTREAM_WORKER,
        filesystem,
      },
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

const upstreamSource = await readFile(UPSTREAM_LINUX, "utf8");
runInThisContext(
  `${upstreamSource}\n;globalThis.__neruLinux = linux;`,
  { filename: UPSTREAM_LINUX },
);
const linux = globalThis.__neruLinux;
delete globalThis.__neruLinux;
if (typeof linux !== "function") {
  throw new Error("Pinned Linux-WASM runtime did not expose its Linux launcher");
}

const kernelBytes = await readFile(kernelPath);
const initramfs = initramfsPath
  ? await readFile(initramfsPath).then((bytes) => bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ))
  : new ArrayBuffer(0);
const kernel = await WebAssembly.compile(kernelBytes);
const commandLine = value("--cmdline") ?? (
  initramfsPath
    ? "maxcpus=1 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0"
    : "maxcpus=1 root=mikuos rootfstype=mikuosfs rw init=/sbin/nemunemu console=hvc console=ttyS0"
);

process.stderr.write(
  initramfsPath
    ? `neru: booting Linux (${variant}) with the legacy proof-of-concept initramfs\n`
    : `neru: booting Linux (${variant}) directly from the live mikuOS userspace\n`,
);
const machine = await linux(
  UPSTREAM_WORKER,
  variant,
  kernel,
  commandLine,
  initramfs,
  (message) => {
    if (verbose) process.stderr.write(`neru: ${message}\n`);
  },
  (message) => process.stdout.write(message),
);

let raw = false;
const restoreTerminal = () => {
  if (raw && process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    raw = false;
  }
};
process.once("exit", restoreTerminal);
process.once("SIGTERM", () => {
  restoreTerminal();
  process.exit(143);
});
process.once("SIGINT", () => machine.key_input("\u0003"));

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  raw = true;
}
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  machine.key_input(Buffer.from(chunk).toString("utf8"));
});
