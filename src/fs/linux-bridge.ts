import type { SharedFsClient } from "./client.js";
import { NeruBinaryFsBridge } from "./binary-bridge.js";

const REQUEST_MAGIC = 0x3151464e;
const LOCK_MAGIC = 0x314c464e;
const ACK_MAGIC = 0x3143464e;
const ERROR_MAGIC = 0x3145464e;
const LOCK_OPCODE = 14;
const UNLOCK_OPCODE = 15;

class Reader {
  private at = 0;
  private readonly view: DataView;
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u32(): number {
    if (this.at + 4 > this.bytes.length) throw new Error("truncated NERU lock request");
    const value = this.view.getUint32(this.at, true); this.at += 4; return value;
  }
  u64(): bigint {
    if (this.at + 8 > this.bytes.length) throw new Error("truncated NERU lock request");
    const value = this.view.getBigUint64(this.at, true); this.at += 8; return value;
  }
  text(): string {
    const size = this.u32();
    if (this.at + size > this.bytes.length) throw new Error("truncated NERU lock string");
    const value = new TextDecoder().decode(this.bytes.slice(this.at, this.at + size));
    this.at += size; return value;
  }
  done(): void { if (this.at !== this.bytes.length) throw new Error("trailing NERU lock request bytes"); }
}

class Writer {
  private chunks: Uint8Array[] = [];
  private size = 0;
  u32(value: number): this {
    const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); return this.bytes(bytes);
  }
  u64(value: number | bigint): this {
    const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true); return this.bytes(bytes);
  }
  text(value: string): this { const bytes = new TextEncoder().encode(value); return this.u32(bytes.length).bytes(bytes); }
  bytes(value: Uint8Array): this { this.chunks.push(value); this.size += value.length; return this; }
  finish(): Uint8Array {
    const output = new Uint8Array(this.size); let at = 0;
    for (const chunk of this.chunks) { output.set(chunk, at); at += chunk.length; }
    return output;
  }
}

interface ActiveLock {
  externalId: string;
  currentId: string;
  path: string;
  owner: string;
  exclusive: boolean;
  ttlMs: number;
}

export class NeruLinuxFsBridge {
  private readonly base: NeruBinaryFsBridge;
  private readonly locks = new Map<string, ActiveLock>();
  private readonly refreshTimer: ReturnType<typeof setInterval>;

  constructor(readonly client: SharedFsClient) {
    this.base = new NeruBinaryFsBridge(client);
    this.refreshTimer = setInterval(() => void this.refreshLocks(), 120_000);
    (this.refreshTimer as unknown as { unref?: () => void }).unref?.();
  }

  async call(bytes: Uint8Array): Promise<Uint8Array> {
    try {
      const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes.byteLength < 16 || header.getUint32(0, true) !== REQUEST_MAGIC) return await this.base.call(bytes);
      const opcode = header.getUint32(4, true);
      if (opcode !== LOCK_OPCODE && opcode !== UNLOCK_OPCODE) return await this.base.call(bytes);
      const reader = new Reader(bytes);
      reader.u32(); reader.u32(); reader.u64();
      if (opcode === LOCK_OPCODE) {
        const exclusive = reader.u32() !== 0;
        const ttlMs = Math.max(5_000, Math.min(reader.u32(), 300_000));
        const path = reader.text();
        const owner = reader.text();
        reader.done();
        const lock = await this.client.acquireLock({ path, owner, exclusive, ttlMs });
        this.locks.set(lock.lockId, {
          externalId: lock.lockId,
          currentId: lock.lockId,
          path,
          owner,
          exclusive,
          ttlMs,
        });
        return new Writer().u32(LOCK_MAGIC).text(lock.lockId).u64(lock.expiresAt).finish();
      }
      const externalId = reader.text();
      reader.done();
      const active = this.locks.get(externalId);
      await this.client.releaseLock(active?.currentId ?? externalId);
      this.locks.delete(externalId);
      const generation = (await this.client.snapshot()).generation;
      return new Writer().u32(ACK_MAGIC).u64(generation).finish();
    } catch (error) {
      const source = error as { code?: string; message?: string };
      return new Writer()
        .u32(ERROR_MAGIC)
        .text(source.code ?? "EIO")
        .text(source.message ?? String(error))
        .finish();
    }
  }

  async close(): Promise<void> {
    clearInterval(this.refreshTimer);
    await Promise.allSettled([...this.locks.values()].map(lock => this.client.releaseLock(lock.currentId)));
    this.locks.clear();
  }

  private async refreshLocks(): Promise<void> {
    await this.client.heartbeat().catch(() => undefined);
    for (const active of [...this.locks.values()]) {
      try {
        const renewed = await this.client.acquireLock({
          path: active.path,
          owner: active.owner,
          exclusive: active.exclusive,
          ttlMs: active.ttlMs,
        });
        const previous = active.currentId;
        active.currentId = renewed.lockId;
        await this.client.releaseLock(previous);
      } catch {
        // The current authority-side lock remains valid until its lease expires.
      }
    }
  }
}
