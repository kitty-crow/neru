import { SHARED_FS_SCHEMA, SharedFsError } from "./protocol.js";
import type {
  AdvisoryLock,
  Lease,
  LockRequest,
  SharedCommitResult,
  SharedOperation,
  SharedSnapshot,
  SharedTransaction,
} from "./protocol.js";

const randomId = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) {
    for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  }
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
};

export interface SharedFsClient {
  readonly clientId: string;
  connect(): Promise<Lease>;
  heartbeat(): Promise<Lease>;
  close(): Promise<void>;
  snapshot(): Promise<SharedSnapshot>;
  commit(operations: SharedOperation[], baseGeneration: number, imageGeneration?: number): Promise<SharedCommitResult>;
  watch(after: number, timeoutMs?: number): Promise<SharedSnapshot | null>;
  acquireLock(request: Omit<LockRequest, "leaseId">): Promise<AdvisoryLock>;
  releaseLock(lockId: string): Promise<void>;
}

export interface FetchSharedFsOptions {
  clientId?: string;
  token?: string;
  fetcher?: typeof fetch;
  leaseTtlMs?: number;
}

export class FetchSharedFsClient implements SharedFsClient {
  readonly clientId: string;
  private readonly fetcher: typeof fetch;
  private lease: Lease | null = null;

  constructor(readonly base: string | URL, private readonly options: FetchSharedFsOptions = {}) {
    this.clientId = options.clientId ?? randomId();
    this.fetcher = options.fetcher ?? fetch;
  }

  async connect(): Promise<Lease> {
    if (this.lease && this.lease.expiresAt > Date.now() + 1_000) return { ...this.lease };
    this.lease = await this.request<Lease>("/v1/leases", {
      method: "POST",
      body: JSON.stringify({ clientId: this.clientId, ttlMs: this.options.leaseTtlMs }),
    });
    return { ...this.lease };
  }

  async heartbeat(): Promise<Lease> {
    const lease = await this.requireLease();
    this.lease = await this.request<Lease>(`/v1/leases/${encodeURIComponent(lease.leaseId)}/heartbeat`, {
      method: "POST",
      body: JSON.stringify({ ttlMs: this.options.leaseTtlMs }),
    });
    return { ...this.lease };
  }

  async close(): Promise<void> {
    if (!this.lease) return;
    const lease = this.lease;
    this.lease = null;
    await this.request<void>(`/v1/leases/${encodeURIComponent(lease.leaseId)}`, { method: "DELETE" });
  }

  snapshot(): Promise<SharedSnapshot> {
    return this.request<SharedSnapshot>("/v1/snapshot");
  }

  async commit(operations: SharedOperation[], baseGeneration: number, imageGeneration?: number): Promise<SharedCommitResult> {
    const lease = await this.requireLease();
    const transaction: SharedTransaction = {
      schema: SHARED_FS_SCHEMA,
      transactionId: randomId(),
      clientId: this.clientId,
      leaseId: lease.leaseId,
      baseGeneration,
      ...(imageGeneration !== undefined ? { imageGeneration } : {}),
      operations,
    };
    return this.request<SharedCommitResult>("/v1/transactions", {
      method: "POST",
      body: JSON.stringify(transaction),
    });
  }

  watch(after: number, timeoutMs = 30_000): Promise<SharedSnapshot | null> {
    return this.request<SharedSnapshot | null>(`/v1/watch?after=${after}&timeout=${timeoutMs}`);
  }

  async acquireLock(request: Omit<LockRequest, "leaseId">): Promise<AdvisoryLock> {
    const lease = await this.requireLease();
    return this.request<AdvisoryLock>("/v1/locks", {
      method: "POST",
      body: JSON.stringify({ ...request, leaseId: lease.leaseId }),
    });
  }

  async releaseLock(lockId: string): Promise<void> {
    const lease = await this.requireLease();
    await this.request<void>(`/v1/locks/${encodeURIComponent(lockId)}?lease=${encodeURIComponent(lease.leaseId)}`, { method: "DELETE" });
  }

  private async requireLease(): Promise<Lease> {
    if (!this.lease || this.lease.expiresAt <= Date.now() + 1_000) return await this.connect();
    return this.lease;
  }

  private url(path: string): URL {
    const root = this.base instanceof URL ? this.base : new URL(this.base);
    return new URL(path.replace(/^\//, ""), root.href.endsWith("/") ? root : new URL(`${root.href}/`));
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (this.options.token) headers.set("authorization", `Bearer ${this.options.token}`);
    const response = await this.fetcher(this.url(path), { ...init, headers, cache: "no-store" });
    const text = await response.text();
    const payload = text ? JSON.parse(text) as unknown : null;
    if (!response.ok) {
      const value = payload as { code?: string; message?: string; detail?: unknown } | null;
      throw new SharedFsError(
        (value?.code as SharedFsError["code"] | undefined) ?? "EINVAL",
        value?.message ?? `shared filesystem HTTP ${response.status}`,
        value?.detail as never,
      );
    }
    return payload as T;
  }
}
