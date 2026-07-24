import assert from "node:assert/strict";
import test from "node:test";
import { bootNeruBrowser, planNeruBrowserBoot } from "../src/browser.js";

test("browser consumes the kernel and host runtime without an initramfs", () => {
  const plan = planNeruBrowserBoot({
    base: "https://example.test/neru/",
    filesystemEndpoint: "https://example.test/fs/",
  });
  assert.equal(plan.kernelUrl.href, "https://example.test/neru/vmlinux.wasm");
  assert.equal(plan.initramfsUrl, undefined);
  assert.equal(plan.runtimeUrl.href, "https://example.test/neru/linux.js");
  assert.equal(plan.workerUrl.href, "https://example.test/neru/linux-worker.js");
  assert.match(plan.commandLine, /rootfstype=mikuosfs/);
});

test("browser boot installs required compatibility and forwards terminal input", async () => {
  const input: string[] = [];
  const fetcher = (async () => new Response(new Uint8Array([0, 97, 115, 109]))) satisfies typeof fetch;
  const machine = await bootNeruBrowser({
    base: "https://example.test/neru/",
    filesystemEndpoint: "https://example.test/fs/",
    crossOriginIsolated: true,
    fetcher,
    compileKernel: async () => ({}) as WebAssembly.Module,
    runtime: async (_worker, _variant, _kernel, _commandLine, initramfs) => {
      const transfer = (ArrayBuffer.prototype as ArrayBuffer & {
        transfer?: (newLength?: number) => ArrayBuffer;
      }).transfer;
      assert.equal(typeof transfer, "function");
      assert.equal(initramfs.byteLength, 0);
      return { key_input: value => input.push(value) };
    },
  });

  machine.keyInput("hello");
  assert.deepEqual(input, ["hello"]);
  machine.terminate();
  machine.keyInput("ignored");
  assert.deepEqual(input, ["hello"]);
});
