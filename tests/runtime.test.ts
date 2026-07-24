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
  await writeFile(paths.kernel, new Uint8Array([0, 97, 115, 109]));
  return paths;
};

test("ships the terminal Linux-WASM runtime", async () => {
  const executable = resolveLinuxRuntime();
  assert.match(executable, /neru-linux-runtime\.mjs$/);
  await access(executable, constants.X_OK);
});

test("boots the kernel alone against the selected live root", async () => {
  const paths = await fixture();
  const plan = planNeruBoot({
    artifactRoot: paths.root,
    linuxRuntime: "/bin/true",
    filesystemRoot: "/tmp/mikuos-root",
  });
  assert.deepEqual(plan.argv, ["--kernel", paths.kernel]);
  assert.equal(plan.environment.NERU_FS_ROOT, "/tmp/mikuos-root");
  assert.equal(plan.initramfs, undefined);
});

test("still supports an explicit proof-of-concept initramfs", async () => {
  const paths = await fixture();
  await writeFile(paths.initramfs, new Uint8Array([1, 2, 3, 4]));
  const plan = planNeruBoot({
    artifactRoot: paths.root,
    linuxRuntime: "/bin/true",
    initramfs: paths.initramfs,
  });
  assert.deepEqual(plan.argv, [
    "--kernel", paths.kernel,
    "--initramfs", paths.initramfs,
  ]);
});

test("probes a kernel-only runtime", async () => {
  const paths = await fixture();
  const result = await probeNeru({ artifactRoot: paths.root, linuxRuntime: "/bin/true" });
  assert.equal(result.kernel, paths.kernel);
  assert.equal(result.initramfs, undefined);
});

test("launches through the terminal host", async () => {
  const paths = await fixture();
  assert.equal(
    await bootNeru({
      artifactRoot: paths.root,
      linuxRuntime: "/bin/true",
      filesystemRoot: "/tmp/mikuos-root",
    }),
    0,
  );
});
