// SPDX-License-Identifier: GPL-2.0-only

import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runInThisContext } from "node:vm";
import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("NERU Linux worker has no parent port");
if (!workerData?.upstreamWorker) {
  throw new Error("NERU Linux worker was not given the pinned upstream worker path");
}

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

Object.defineProperty(globalThis, "__neruFilesystemConfig", {
  configurable: false,
  enumerable: false,
  writable: false,
  value: workerData.filesystem ?? null,
});

let onmessage = null;
let onmessageerror = null;
const pending = [];

const selfShim = {
  postMessage(message) {
    parentPort.postMessage(message);
  },
};

Object.defineProperty(selfShim, "onmessage", {
  get: () => onmessage,
  set: (handler) => {
    onmessage = handler;
    while (onmessage && pending.length) {
      onmessage({ data: pending.shift() });
    }
  },
});

Object.defineProperty(selfShim, "onmessageerror", {
  get: () => onmessageerror,
  set: (handler) => {
    onmessageerror = handler;
  },
});

Object.defineProperty(globalThis, "self", {
  configurable: true,
  value: selfShim,
});

parentPort.on("message", (data) => {
  if (onmessage) onmessage({ data });
  else pending.push(data);
});
parentPort.on("messageerror", (error) => {
  if (onmessageerror) onmessageerror(error);
  else throw error;
});

const source = await readFile(workerData.upstreamWorker, "utf8");
runInThisContext(source, { filename: workerData.upstreamWorker });
