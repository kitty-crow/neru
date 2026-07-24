// SPDX-License-Identifier: GPL-2.0-only

export {};

declare global {
  type NeruTestFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
}
