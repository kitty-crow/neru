import assert from "node:assert/strict";
import test from "node:test";
import { AuthoritativeFilesystem, MemoryPersistence } from "../src/fs/core.js";
import { FetchSharedFsClient } from "../src/fs/client.js";
import { NeruBinaryFsBridge, NeruFsOpcode } from "../src/fs/binary-bridge.js";
import { SharedFsHttpServer } from "../src/fs/server.js";

const NFQ1 = 0x3151464e;
const NFS1 = 0x3153464e;
const NFC1 = 0x3143464e;

class Request {
  private chunks: Uint8Array[] = [];
  private size = 0;
  u32(value: number): this {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    this.chunks.push(bytes); this.size += bytes.length; return this;
  }
  u64(value: number | bigint): this {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
    this.chunks.push(bytes); this.size += bytes.length; return this;
  }
  blob(value: Uint8Array): this { return this.u32(value.length).bytes(value); }
  text(value: string): this { return this.blob(new TextEncoder().encode(value)); }
  bytes(value: Uint8Array): this { this.chunks.push(value); this.size += value.length; return this; }
  finish(): Uint8Array {
    const output = new Uint8Array(this.size);
    let at = 0;
    for (const chunk of this.chunks) { output.set(chunk, at); at += chunk.length; }
    return output;
  }
}

const header = (opcode: NeruFsOpcode, generation: number): Request =>
  new Request().u32(NFQ1).u32(opcode).u64(generation);

test("binary Linux bridge snapshots and mutates the authoritative namespace", async () => {
  const filesystem = await AuthoritativeFilesystem.open(new MemoryPersistence(), { filesystemId: "binary" });
  const listening = await new SharedFsHttpServer(filesystem).listen();
  const client = new FetchSharedFsClient(listening.url, { clientId: "linux-fuse" });
  try {
    await client.connect();
    const bridge = new NeruBinaryFsBridge(client);
    const snapshot = await bridge.call(header(NeruFsOpcode.Snapshot, 0).finish());
    assert.equal(new DataView(snapshot.buffer, snapshot.byteOffset).getUint32(0, true), NFS1);

    const create = header(NeruFsOpcode.Create, 0)
      .u32(2)
      .u32(0o755)
      .u32(0)
      .u32(0)
      .text("/etc")
      .blob(new Uint8Array())
      .text("")
      .finish();
    const committed = await bridge.call(create);
    assert.equal(new DataView(committed.buffer, committed.byteOffset).getUint32(0, true), NFC1);
    assert.equal((await client.snapshot()).entries.some(entry => entry.path === "/etc"), true);
  } finally {
    await client.close().catch(() => undefined);
    await listening.close();
  }
});
