import assert from "node:assert/strict";
import test from "node:test";
import { artifactPaths, planNeruBoot } from "../src/runtime.js";

test("fixed runtime artefacts are independent of a mikuOS userspace image", () => {
  const artefacts = artifactPaths("/tmp/neru-runtime-wasm32_nommu");
  assert.equal(artefacts.root, "/tmp/neru-runtime-wasm32_nommu");
  assert.equal(artefacts.kernel, "/tmp/neru-runtime-wasm32_nommu/vmlinux.wasm");
  assert.equal(artefacts.initramfs, "/tmp/neru-runtime-wasm32_nommu/initramfs.cpio.gz");
});

test("boot plan passes the live filesystem authority to the host runtime", () => {
  const plan = planNeruBoot({
    artifactRoot: "/tmp/neru-runtime-wasm32_nommu",
    linuxRuntime: "/tmp/neru-linux-runtime.mjs",
    filesystemEndpoint: "http://127.0.0.1:3940",
    filesystemClientId: "test-client",
  });
  assert.equal(plan.environment.NERU_FS_ENDPOINT, "http://127.0.0.1:3940");
  assert.equal(plan.environment.NERU_FS_CLIENT_ID, "test-client");
  assert.equal(plan.argv.includes("--userland"), false);
});
