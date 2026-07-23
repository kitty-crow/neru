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

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "neru-"));
  const paths = artifactPaths(root);
  await Promise.all([
    writeFile(paths.kernel, new Uint8Array([0, 97, 115, 109])),
    writeFile(paths.initramfs, new Uint8Array([1, 2, 3, 4])),
  ]);
  return paths;
};

test("ships the terminal Linux-WASM runtime", async () => {
  const executable = resolveLinuxRuntime();
  assert.match(executable, /neru-linux-runtime\.mjs$/);
  await access(executable, constants.X_OK);
});

test("boots only the ahead-of-time kernel and initramfs artefacts", async () => {
  const paths = await fixture();
  const plan = planNeruBoot({ artifactRoot: paths.root, linuxRuntime: "/bin/true" });
  assert.deepEqual(plan.argv, [
    "--kernel", paths.kernel,
    "--initramfs", paths.initramfs,
    "--init", "/init",
  ]);
  assert.equal(plan.argv.some(value => value.includes("guest-image")), false);
});

test("probes the shared CLI/web image", async () => {
  const paths = await fixture();
  const result = await probeNeru({ artifactRoot: paths.root, linuxRuntime: "/bin/true" });
  assert.equal(result.kernel, paths.kernel);
  assert.equal(result.initramfs, paths.initramfs);
});

test("launches through the terminal host", async () => {
  const paths = await fixture();
  assert.equal(
    await bootNeru({ artifactRoot: paths.root, linuxRuntime: "/bin/true" }),
    0,
  );
});
