import type { SharedFsClient } from "./client.js";
import { decodeBytes } from "./protocol.js";
import type { SharedEntry, SharedOperation, SharedSnapshot } from "./protocol.js";

const REQUEST_MAGIC = 0x3151464e; // NFQ1
const SNAPSHOT_MAGIC = 0x3153464e; // NFS1
const COMMIT_MAGIC = 0x3143464e; // NFC1
const ERROR_MAGIC = 0x3145464e; // NFE1
const NONE = 0xffffffffffffffffn;
const NULL_VERSION = 0xfffffffffffffffen;

export const enum NeruFsOpcode {
  Snapshot = 1,
  Create = 2,
  Write = 3,
  Truncate = 4,
  Rename = 5,
  Unlink = 6,
  Mkdir = 7,
  Rmdir = 8,
  Chmod = 9,
  Chown = 10,
  Link = 11,
  Symlink = 12,
  Fsync = 13,
}

class Reader {
  private at = 0;
  private readonly view: DataView;
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u32(): number {
    this.need(4);
    const value = this.view.getUint32(this.at, true);
    this.at += 4;
    return value;
  }
  u64(): bigint {
    this.need(8);
    const value = this.view.getBigUint64(this.at, true);
    this.at += 8;
    return value;
  }
  blob(): Uint8Array {
    const size = this.u32();
    this.need(size);
    const value = this.bytes.slice(this.at, this.at + size);
    this.at += size;
    return value;
  }
  text(): string { return new TextDecoder().decode(this.blob()); }
  done(): void {
    if (this.at !== this.bytes.length) throw new Error("trailing NERU filesystem request bytes");
  }
  private need(size: number): void {
    if (this.at + size > this.bytes.length) throw new Error("truncated NERU filesystem request");
  }
}

class Writer {
  private chunks: Uint8Array[] = [];
  private size = 0;
  u32(value: number): void {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    this.push(bytes);
  }
  u64(value: bigint | number): void {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
    this.push(bytes);
  }
  blob(value: Uint8Array): void { this.u32(value.length); this.push(value); }
  text(value: string): void { this.blob(new TextEncoder().encode(value)); }
  finish(): Uint8Array {
    const output = new Uint8Array(this.size);
    let at = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, at);
      at += chunk.length;
    }
    return output;
  }
  private push(value: Uint8Array): void { this.chunks.push(value); this.size += value.length; }
}

const expected = (value: bigint): number | undefined => value === NONE ? undefined : Number(value);
const targetExpected = (value: bigint): number | null | undefined =>
  value === NONE ? undefined : value === NULL_VERSION ? null : Number(value);
const kind = (value: number): "file" | "directory" | "symlink" => {
  if (value === 1) return "file";
  if (value === 2) return "directory";
  if (value === 3) return "symlink";
  throw new Error(`invalid NERU filesystem kind ${value}`);
};
const kindCode = (value: SharedEntry["kind"]): number => value === "file" ? 1 : value === "directory" ? 2 : 3;
const inode = (value: string): bigint => {
  const numeric = BigInt(value);
  if (numeric <= 0n) throw new Error(`invalid shared inode ${value}`);
  return numeric;
};

const bytesBase64 = (bytes: Uint8Array): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const value = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    output += alphabet[(value >>> 18) & 63];
    output += alphabet[(value >>> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(value >>> 6) & 63] : "=";
    output += index + 2 < bytes.length ? alphabet[value & 63] : "=";
  }
  return output;
};

const decodeOperation = (opcode: NeruFsOpcode, reader: Reader): SharedOperation => {
  switch (opcode) {
    case NeruFsOpcode.Create: {
      const entryKind = kind(reader.u32());
      const mode = reader.u32();
      const uid = reader.u32();
      const gid = reader.u32();
      const path = reader.text();
      const data = reader.blob();
      const target = reader.text();
      return {
        op: "create",
        path,
        kind: entryKind,
        mode,
        uid,
        gid,
        ...(entryKind === "file" ? { data: bytesBase64(data) } : {}),
        ...(entryKind === "symlink" ? { target } : {}),
      };
    }
    case NeruFsOpcode.Write: {
      const version = expected(reader.u64());
      const offset = Number(reader.u64());
      const truncate = reader.u32() !== 0;
      const path = reader.text();
      const data = reader.blob();
      return {
        op: "write",
        path,
        offset,
        data: bytesBase64(data),
        truncate,
        ...(version !== undefined ? { expectedVersion: version } : {}),
      };
    }
    case NeruFsOpcode.Truncate: {
      const version = expected(reader.u64());
      const size = Number(reader.u64());
      const path = reader.text();
      return { op: "truncate", path, size, ...(version !== undefined ? { expectedVersion: version } : {}) };
    }
    case NeruFsOpcode.Rename: {
      const version = expected(reader.u64());
      const targetVersion = targetExpected(reader.u64());
      const from = reader.text();
      const to = reader.text();
      return {
        op: "rename",
        from,
        to,
        ...(version !== undefined ? { expectedVersion: version } : {}),
        ...(targetVersion !== undefined ? { expectedTargetVersion: targetVersion } : {}),
      };
    }
    case NeruFsOpcode.Unlink:
    case NeruFsOpcode.Rmdir: {
      const version = expected(reader.u64());
      const path = reader.text();
      return {
        op: opcode === NeruFsOpcode.Unlink ? "unlink" : "rmdir",
        path,
        ...(version !== undefined ? { expectedVersion: version } : {}),
      };
    }
    case NeruFsOpcode.Mkdir: {
      const mode = reader.u32();
      const uid = reader.u32();
      const gid = reader.u32();
      const path = reader.text();
      return { op: "mkdir", path, mode, uid, gid };
    }
    case NeruFsOpcode.Chmod: {
      const version = expected(reader.u64());
      const mode = reader.u32();
      const path = reader.text();
      return { op: "chmod", path, mode, ...(version !== undefined ? { expectedVersion: version } : {}) };
    }
    case NeruFsOpcode.Chown: {
      const version = expected(reader.u64());
      const uid = reader.u32();
      const gid = reader.u32();
      const path = reader.text();
      return { op: "chown", path, uid, gid, ...(version !== undefined ? { expectedVersion: version } : {}) };
    }
    case NeruFsOpcode.Link: {
      const version = expected(reader.u64());
      const from = reader.text();
      const to = reader.text();
      return { op: "link", from, to, ...(version !== undefined ? { expectedVersion: version } : {}) };
    }
    case NeruFsOpcode.Symlink: {
      const mode = reader.u32();
      const uid = reader.u32();
      const gid = reader.u32();
      const path = reader.text();
      const target = reader.text();
      return { op: "symlink", path, target, mode, uid, gid };
    }
    case NeruFsOpcode.Fsync: {
      const version = expected(reader.u64());
      const path = reader.text();
      return {
        op: "fsync",
        ...(path ? { path } : {}),
        ...(version !== undefined ? { expectedVersion: version } : {}),
      };
    }
    default:
      throw new Error(`unsupported NERU filesystem opcode ${opcode}`);
  }
};

export const encodeSnapshot = (snapshot: SharedSnapshot): Uint8Array => {
  const writer = new Writer();
  writer.u32(SNAPSHOT_MAGIC);
  writer.u64(snapshot.generation);
  writer.u64(snapshot.imageGeneration);
  writer.u32(snapshot.entries.length);
  for (const entry of snapshot.entries) {
    writer.u64(inode(entry.inode));
    writer.u64(entry.version);
    writer.u64(entry.atimeMs);
    writer.u64(entry.mtimeMs);
    writer.u64(entry.ctimeMs);
    writer.u32(entry.mode);
    writer.u32(entry.uid);
    writer.u32(entry.gid);
    writer.u32(entry.nlink);
    writer.u32(kindCode(entry.kind));
    writer.text(entry.path);
    writer.text(entry.target ?? "");
    writer.blob(entry.kind === "file" ? decodeBytes(entry.data) : new Uint8Array());
  }
  return writer.finish();
};

export class NeruBinaryFsBridge {
  constructor(readonly client: SharedFsClient) {}

  async call(bytes: Uint8Array): Promise<Uint8Array> {
    try {
      const reader = new Reader(bytes);
      if (reader.u32() !== REQUEST_MAGIC) throw new Error("invalid NERU filesystem request magic");
      const opcode = reader.u32() as NeruFsOpcode;
      const baseGeneration = Number(reader.u64());
      if (opcode === NeruFsOpcode.Snapshot) {
        reader.done();
        return encodeSnapshot(await this.client.snapshot());
      }
      const operation = decodeOperation(opcode, reader);
      reader.done();
      const committed = await this.client.commit([operation], baseGeneration);
      const writer = new Writer();
      writer.u32(COMMIT_MAGIC);
      writer.u64(committed.generation);
      return writer.finish();
    } catch (error) {
      const source = error as { code?: string; message?: string };
      const writer = new Writer();
      writer.u32(ERROR_MAGIC);
      writer.text(source.code ?? "EIO");
      writer.text(source.message ?? String(error));
      return writer.finish();
    }
  }
}
