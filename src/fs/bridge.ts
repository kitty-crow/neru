import { FetchSharedFsClient } from "./client.js";
import type { SharedFsClient } from "./client.js";
import type { LockRequest, SharedOperation } from "./protocol.js";

export const NERU_FS_BRIDGE_SCHEMA = 1 as const;

export type NeruFsBridgeRequest =
  | { schema: 1; id: string; method: "connect" }
  | { schema: 1; id: string; method: "heartbeat" }
  | { schema: 1; id: string; method: "snapshot" }
  | { schema: 1; id: string; method: "commit"; baseGeneration: number; imageGeneration?: number; operations: SharedOperation[] }
  | { schema: 1; id: string; method: "lock"; request: Omit<LockRequest, "leaseId"> }
  | { schema: 1; id: string; method: "unlock"; lockId: string };

export type NeruFsBridgeResponse =
  | { schema: 1; id: string; ok: true; value: unknown }
  | { schema: 1; id: string; ok: false; error: { name: string; message: string; code?: string; detail?: unknown } };

export interface NeruFsBridgeOptions {
  endpoint: string | URL;
  token?: string;
  clientId?: string;
  fetcher?: typeof fetch;
}

export class NeruFsBridge {
  readonly client: SharedFsClient;
  constructor(options: NeruFsBridgeOptions | SharedFsClient) {
    this.client = "snapshot" in options
      ? options
      : new FetchSharedFsClient(options.endpoint, {
          ...(options.token ? { token: options.token } : {}),
          ...(options.clientId ? { clientId: options.clientId } : {}),
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        });
  }

  async call(request: NeruFsBridgeRequest): Promise<NeruFsBridgeResponse> {
    try {
      if (request.schema !== NERU_FS_BRIDGE_SCHEMA) throw new Error("unsupported NERU filesystem bridge schema");
      let value: unknown;
      switch (request.method) {
        case "connect": value = await this.client.connect(); break;
        case "heartbeat": value = await this.client.heartbeat(); break;
        case "snapshot": value = await this.client.snapshot(); break;
        case "commit": value = await this.client.commit(request.operations, request.baseGeneration, request.imageGeneration); break;
        case "lock": value = await this.client.acquireLock(request.request); break;
        case "unlock": await this.client.releaseLock(request.lockId); value = { ok: true }; break;
      }
      return { schema: 1, id: request.id, ok: true, value };
    } catch (error) {
      const source = error as { name?: string; message?: string; code?: string; detail?: unknown };
      return {
        schema: 1,
        id: request.id,
        ok: false,
        error: {
          name: source.name ?? "Error",
          message: source.message ?? String(error),
          ...(source.code ? { code: source.code } : {}),
          ...(source.detail !== undefined ? { detail: source.detail } : {}),
        },
      };
    }
  }

  async json(request: string): Promise<string> {
    let id = "invalid";
    try {
      const parsed = JSON.parse(request) as NeruFsBridgeRequest;
      id = typeof parsed.id === "string" ? parsed.id : id;
      return JSON.stringify(await this.call(parsed));
    } catch (error) {
      return JSON.stringify({
        schema: 1,
        id,
        ok: false,
        error: { name: "SyntaxError", message: error instanceof Error ? error.message : String(error), code: "EINVAL" },
      } satisfies NeruFsBridgeResponse);
    }
  }
}
