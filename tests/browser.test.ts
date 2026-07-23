import assert from "node:assert/strict";
import test from "node:test";
import { bootNeruBrowser, planNeruBrowserBoot } from "../src/browser.js";

test("browser and CLI consume the same named artefacts and authority", () => {
  const plan = planNeruBrowserBoot({
    base: "https://example.test/neru/",
    sharedFs: "https://storage.test/mikuos/",
  });
  assert.equal(plan.kernelUrl.href, "https://example.test/neru/vmlinux.wasm");
  assert.equal(plan.initramfsUrl.href, "https://example.test/neru/initramfs.cpio.gz");
  assert.equal(plan.runtimeUrl.href, "https://example.test/neru/linux.js");
  assert.equal(plan.workerUrl.href, "https://example.test/neru/linux-worker.js");
  assert.equal(plan.sharedFs.href, "https://storage.test/mikuos/");
});

test("browser refuses a private divergent userspace", () => {
  assert.throws(
    () => planNeruBrowserBoot({ base: "https://example.test/neru/" }),
    /common authoritative shared-filesystem endpoint/,
  );
});

test("browser boot attaches authority and forwards terminal input", async () => {
  const input: string[] = [];
  const fetcher = (async (source: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof source === "string" || source instanceof URL ? source : source.url);
    if (url.hostname === "storage.test") {
      if (url.pathname.endsWith("/v1/leases") && init?.method === "POST") {
        return Response.json({ leaseId: "lease", clientId: "web", expiresAt: Date.now() + 60_000 });
      }
      if (url.pathname.endsWith("/v1/snapshot")) {
        return Response.json({
          schema: 1,
          filesystemId: "web",
          generation: 7,
          imageGeneration: 3,
          committedAt: new Date(0).toISOString(),
          checksum: "test",
          entries: [],
        });
      }
      if (url.pathname.includes("/v1/leases/") && init?.method === "DELETE") {
        return Response.json({ ok: true });
      }
      throw new Error(`unexpected storage request: ${url} ${init?.method ?? "GET"}`);
    }
    return new Response(new Uint8Array([0, 97, 115, 109]));
  }) as typeof fetch;
  const machine = await bootNeruBrowser({
    base: "https://example.test/neru/",
    sharedFs: "https://storage.test/mikuos/",
    crossOriginIsolated: true,
    fetcher,
    compileKernel: async () => ({}) as WebAssembly.Module,
    runtime: async (_worker, _variant, _kernel, _commandLine, _initramfs, _log, _write, fsBridge) => {
      assert.equal(typeof fsBridge, "function");
      return { key_input: value => input.push(value) };
    },
  });

  machine.keyInput("hello");
  assert.deepEqual(input, ["hello"]);
  machine.terminate();
  machine.keyInput("ignored");
  assert.deepEqual(input, ["hello"]);
});
