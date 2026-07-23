import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactPaths,
  bootNeru,
  planNeruBoot,
  probeNeru,
  resolveLinuxRuntime,
} from "../src/runtime.js";

const sharedFs = "http://127.0.0.1:3939/";
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "neru-"));
  const paths = artifactPaths(root);
  await Promise.all([
    writeFile(paths.kernel, new Uint8Array([0, 97, 115, 109])),
    writeFile(paths.initramfs, new Uint8Array([1, 2, 3, 4])),
    writeFile(paths.browserRuntime, "const linux = async () => ({ key_input() {} });\n"),
    writeFile(paths.browserWorker, "self.onmessage = () => {};\n"),
  ]);
  return paths;
};

test("ships the terminal Linux-WASM runtime", async () => {
  const executable = resolveLinuxRuntime();
  assert.match(executable, /neru-linux-runtime\.mjs$/);
  await access(executable, constants.X_OK);
});

test("boots only the ahead-of-time artefacts and authoritative endpoint", async () => {
  const paths = await fixture();
  const plan = planNeruBoot({
    artifactRoot: paths.root,
    linuxRuntime: "/bin/true",
    sharedFs,
  });
  assert.deepEqual(plan.argv, [
    "--kernel", paths.kernel,
    "--initramfs", paths.initramfs,
    "--runtime", paths.browserRuntime,
    "--worker", paths.browserWorker,
    "--shared-fs", sharedFs,
  ]);
  assert.equal(plan.argv.some(value => value.includes("guest-image")), false);
  assert.equal(plan.environment.MIKUOS_FS_URL, sharedFs);
});

test("refuses to plan a divergent NERU boot", async () => {
  const paths = await fixture();
  assert.throws(
    () => planNeruBoot({ artifactRoot: paths.root, linuxRuntime: "/bin/true" }),
    /authoritative mikuOS filesystem endpoint/,
  );
});

test("probes the shared CLI/web image", async () => {
  const paths = await fixture();
  const result = await probeNeru({
    artifactRoot: paths.root,
    linuxRuntime: "/bin/true",
    sharedFs,
  });
  assert.equal(result.kernel, paths.kernel);
  assert.equal(result.initramfs, paths.initramfs);
  assert.equal(result.browserRuntime, paths.browserRuntime);
  assert.equal(result.browserWorker, paths.browserWorker);
  assert.equal(result.sharedFs, sharedFs);
});

test("launches through the terminal host", async () => {
  const paths = await fixture();
  assert.equal(
    await bootNeru({
      artifactRoot: paths.root,
      linuxRuntime: "/bin/true",
      sharedFs,
    }),
    0,
  );
});
