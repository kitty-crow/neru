import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { SharedFsError } from "./protocol.js";
import type { LockRequest, SharedSnapshot, SharedTransaction } from "./protocol.js";
import type { AuthoritativeFilesystem } from "./core.js";

export interface SharedFsServerOptions {
  hostname?: string;
  port?: number;
  token?: string;
  maxBodyBytes?: number;
}

const send = (response: ServerResponse, status: number, value: unknown): void => {
  const body = value === undefined ? "" : `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  });
  response.end(body);
};

const body = async (request: IncomingMessage, limit: number): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new SharedFsError("EINVAL", "request body is too large");
    chunks.push(bytes);
  }
  return size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown : {};
};

export class SharedFsHttpServer {
  private server: Server | null = null;
  constructor(readonly filesystem: AuthoritativeFilesystem, readonly options: SharedFsServerOptions = {}) {}

  async listen(): Promise<{ url: URL; close(): Promise<void> }> {
    if (this.server) throw new Error("shared filesystem server is already running");
    const server = createServer((request, response) => void this.route(request, response));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port ?? 0, this.options.hostname ?? "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("shared filesystem server has no TCP address");
    const url = new URL(`http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}/`);
    return {
      url,
      close: async () => {
        if (!this.server) return;
        const active = this.server;
        this.server = null;
        await new Promise<void>((resolve, reject) => active.close(error => error ? reject(error) : resolve()));
      },
    };
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === "OPTIONS") { send(response, 204, undefined); return; }
      if (this.options.token && request.headers.authorization !== `Bearer ${this.options.token}`) {
        send(response, 401, { code: "EINVAL", message: "unauthorised" });
        return;
      }
      const url = new URL(request.url ?? "/", "http://shared.invalid");
      const limit = this.options.maxBodyBytes ?? 64 * 1024 * 1024;
      if (request.method === "GET" && url.pathname === "/v1/health") {
        send(response, 200, { ok: true, generation: this.filesystem.snapshot().generation });
      } else if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        send(response, 200, this.filesystem.snapshot());
      } else if (request.method === "GET" && url.pathname === "/v1/watch") {
        const after = Number(url.searchParams.get("after") ?? 0);
        const timeout = Number(url.searchParams.get("timeout") ?? 30_000);
        send(response, 200, await this.filesystem.watch(after, timeout));
      } else if (request.method === "POST" && url.pathname === "/v1/seed") {
        send(response, 200, await this.filesystem.seed(await body(request, limit) as SharedSnapshot));
      } else if (request.method === "POST" && url.pathname === "/v1/leases") {
        send(response, 201, this.filesystem.createLease(await body(request, limit) as { clientId: string; ttlMs?: number }));
      } else if (request.method === "POST" && /^\/v1\/leases\/[^/]+\/heartbeat$/.test(url.pathname)) {
        const leaseId = decodeURIComponent(url.pathname.split("/")[3]!);
        const value = await body(request, limit) as { ttlMs?: number };
        send(response, 200, this.filesystem.heartbeat(leaseId, value.ttlMs));
      } else if (request.method === "DELETE" && /^\/v1\/leases\/[^/]+$/.test(url.pathname)) {
        this.filesystem.releaseLease(decodeURIComponent(url.pathname.split("/")[3]!));
        send(response, 200, { ok: true });
      } else if (request.method === "POST" && url.pathname === "/v1/transactions") {
        send(response, 200, await this.filesystem.commit(await body(request, limit) as SharedTransaction));
      } else if (request.method === "POST" && url.pathname === "/v1/locks") {
        send(response, 201, this.filesystem.acquireLock(await body(request, limit) as LockRequest));
      } else if (request.method === "DELETE" && /^\/v1\/locks\/[^/]+$/.test(url.pathname)) {
        const lockId = decodeURIComponent(url.pathname.split("/")[3]!);
        this.filesystem.releaseLock(lockId, url.searchParams.get("lease") ?? "");
        send(response, 200, { ok: true });
      } else {
        send(response, 404, { code: "ENOENT", message: "not found" });
      }
    } catch (error) {
      if (error instanceof SharedFsError) {
        send(response, error.code === "ESTALE" || error.code === "ELOCKED" ? 409 : 400, {
          code: error.code,
          message: error.message,
          detail: error.detail,
        });
      } else {
        send(response, 500, { code: "EINVAL", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}
