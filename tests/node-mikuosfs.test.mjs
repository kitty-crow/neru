import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNodeMikuosFs } from "../runtime/node-mikuosfs.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const put = (memory, pointer, value) => {
  const bytes = encoder.encode(`${value}\0`);
  new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
};

const get = (memory, pointer) => {
  const bytes = new Uint8Array(memory.buffer);
  let end = pointer;
  while (bytes[end] !== 0) end++;
  return decoder.decode(bytes.subarray(pointer, end));
};

test("Node mikuosfs exposes one rooted read-only namespace", () => {
  const root = mkdtempSync(join(tmpdir(), "neru-mikuosfs-"));
  try {
    mkdirSync(join(root, "sbin"));
    writeFileSync(join(root, "sbin", "nemunemu"), "NERU", { mode: 0o755 });
    symlinkSync("nemunemu", join(root, "sbin", "init"));

    const memory = new WebAssembly.Memory({ initial: 1 });
    const filesystem = createNodeMikuosFs(root);

    put(memory, 0x100, "/");
    put(memory, 0x180, "/sbin");
    put(memory, 0x200, "/sbin/nemunemu");
    put(memory, 0x280, "/sbin/init");

    assert.equal(filesystem.mode(memory, 0x100) & 0o170000, 0o040000);
    assert.equal(filesystem.mode(memory, 0x200) & 0o170000, 0o100000);
    assert.equal(filesystem.size(memory, 0x200), 4n);

    assert.equal(filesystem.read(memory, 0x200, 0n, 0x400, 4), 4);
    assert.equal(decoder.decode(new Uint8Array(memory.buffer, 0x400, 4)), "NERU");

    assert.equal(filesystem.readdir(memory, 0x180, 0, 0x500, 256), 4);
    assert.equal(get(memory, 0x500), "init");
    assert.equal(filesystem.readdir(memory, 0x180, 1, 0x500, 256), 8);
    assert.equal(get(memory, 0x500), "nemunemu");
    assert.equal(filesystem.readdir(memory, 0x180, 2, 0x500, 256), 0);

    assert.equal(filesystem.readlink(memory, 0x280, 0x600, 256), 8);
    assert.equal(get(memory, 0x600), "nemunemu");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
