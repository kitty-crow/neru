import assert from "node:assert/strict";
import test from "node:test";
import { artifactPaths, planNeruBoot } from "../src/runtime.js";

test("fixed runtime artefacts are independent of a mikuOS userspace image", () => {
  const artefacts = artifactPaths("/tmp/neru-runtime-wasm32_nommu");
  assert.equal(artefacts.root, "/tmp/neru-runtime-wasm32_nommu");
  assert.equal(artefacts.kernel, "/tmp/neru-runtime-wasm32_nommu/vmlinux.wasm");
});

test("boot plan passes the exact local mikuOS root to the host runtime", () => {
  const plan = planNeruBoot({
    artifactRoot: "/tmp/neru-runtime-wasm32_nommu",
    linuxRuntime: "/tmp/neru-linux-runtime.mjs",
    filesystemRoot: "/tmp/mikuos-root",
    filesystemClientId: "test-client",
  });
  assert.equal(plan.environment.NERU_FS_ROOT, "/tmp/mikuos-root");
  assert.equal(plan.environment.NERU_FS_CLIENT_ID, "test-client");
  assert.equal(plan.argv.includes("--initramfs"), false);
  assert.equal(plan.argv.includes("--userland"), false);
});
