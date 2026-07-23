import assert from "node:assert/strict";
import test from "node:test";
import { bootNeruBrowser, planNeruBrowserBoot } from "../src/browser.js";

test("browser and CLI consume the same named artefacts", () => {
  const plan = planNeruBrowserBoot({ base: "https://example.test/neru/" });
  assert.equal(plan.kernelUrl.href, "https://example.test/neru/vmlinux.wasm");
  assert.equal(plan.initramfsUrl.href, "https://example.test/neru/initramfs.cpio.gz");
  assert.equal(plan.runtimeUrl.href, "https://example.test/neru/linux.js");
  assert.equal(plan.workerUrl.href, "https://example.test/neru/linux-worker.js");
});

test("browser boot installs required compatibility and forwards terminal input", async () => {
  const input: string[] = [];
  const fetcher = (async () => new Response(new Uint8Array([0, 97, 115, 109]))) as typeof fetch;
  const machine = await bootNeruBrowser({
    base: "https://example.test/neru/",
    crossOriginIsolated: true,
    fetcher,
    compileKernel: async () => ({}) as WebAssembly.Module,
    runtime: async () => {
      const transfer = (ArrayBuffer.prototype as ArrayBuffer & {
        transfer?: (newLength?: number) => ArrayBuffer;
      }).transfer;
      assert.equal(typeof transfer, "function");
      return { key_input: value => input.push(value) };
    },
  });

  machine.keyInput("hello");
  assert.deepEqual(input, ["hello"]);
  machine.terminate();
  machine.keyInput("ignored");
  assert.deepEqual(input, ["hello"]);
});
