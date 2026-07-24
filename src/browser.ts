import type { NeruVariant } from "./types.js";

export interface NeruBrowserMachine {
  keyInput(data: string): void;
  terminate(): void;
}

export interface NeruBrowserBootOptions {
  base?: string | URL;
  runtimeUrl?: string | URL;
  workerUrl?: string | URL;
  kernelUrl?: string | URL;
  /** Explicitly set only for the legacy proof-of-concept image. */
  initramfsUrl?: string | URL;
  filesystemEndpoint?: string;
  filesystemToken?: string;
  filesystemClientId?: string;
  variant?: NeruVariant;
  commandLine?: string;
  log?: (message: string) => void;
  write?: (message: string) => void;
  fetcher?: typeof fetch;
  runtime?: NeruLinuxBrowserRuntime;
  compileKernel?: (bytes: ArrayBuffer) => Promise<WebAssembly.Module>;
  crossOriginIsolated?: boolean;
}

export interface NeruBrowserBootPlan {
  runtimeUrl: URL;
  workerUrl: URL;
  kernelUrl: URL;
  initramfsUrl?: URL;
  filesystemEndpoint?: string;
  filesystemToken?: string;
  filesystemClientId?: string;
  variant: NeruVariant;
  commandLine: string;
}

interface UpstreamLinuxMachine {
  key_input(data: string): void;
}

export type NeruLinuxBrowserRuntime = (
  workerUrl: string,
  variant: string,
  kernel: WebAssembly.Module,
  commandLine: string,
  initramfs: ArrayBuffer,
  log: (message: string) => void,
  write: (message: string) => void,
) => Promise<UpstreamLinuxMachine>;

interface TransferableArrayBuffer extends ArrayBuffer {
  transfer?(newLength?: number): ArrayBuffer;
}

const installArrayBufferTransfer = (): void => {
  const prototype = ArrayBuffer.prototype as TransferableArrayBuffer;
  if (typeof prototype.transfer === "function") return;

  Object.defineProperty(prototype, "transfer", {
    configurable: true,
    writable: true,
    value(this: ArrayBuffer, newLength = this.byteLength): ArrayBuffer {
      if (!Number.isInteger(newLength) || newLength < 0) {
        throw new RangeError("invalid ArrayBuffer transfer length");
      }
      const source = new Uint8Array(this);
      const output = new ArrayBuffer(newLength);
      new Uint8Array(output).set(source.subarray(0, Math.min(source.length, newLength)));
      return output;
    },
  });
};

const absolute = (value: string | URL, base: URL): URL =>
  value instanceof URL ? value : new URL(value, base);

export function planNeruBrowserBoot(
  options: NeruBrowserBootOptions = {},
): NeruBrowserBootPlan {
  const documentBase = typeof document === "undefined"
    ? new URL("http://localhost/")
    : new URL(document.baseURI);
  const base = absolute(options.base ?? "./neru/", documentBase);
  const variant = options.variant ?? "wasm32_nommu";
  const initramfsUrl = options.initramfsUrl
    ? absolute(options.initramfsUrl, base)
    : undefined;
  return {
    runtimeUrl: absolute(options.runtimeUrl ?? "linux.js", base),
    workerUrl: absolute(options.workerUrl ?? "linux-worker.js", base),
    kernelUrl: absolute(options.kernelUrl ?? "vmlinux.wasm", base),
    ...(initramfsUrl ? { initramfsUrl } : {}),
    ...(options.filesystemEndpoint ? { filesystemEndpoint: options.filesystemEndpoint } : {}),
    ...(options.filesystemToken ? { filesystemToken: options.filesystemToken } : {}),
    ...(options.filesystemClientId ? { filesystemClientId: options.filesystemClientId } : {}),
    variant,
    commandLine: options.commandLine ?? (
      initramfsUrl
        ? "maxcpus=1 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0"
        : "maxcpus=1 root=mikuos rootfstype=mikuosfs rw init=/sbin/nemunemu console=hvc console=ttyS0"
    ),
  };
}

export async function loadNeruLinuxBrowserRuntime(
  runtimeUrl: URL,
  fetcher: typeof fetch = fetch,
): Promise<NeruLinuxBrowserRuntime> {
  const response = await fetcher(runtimeUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`${runtimeUrl.pathname}: HTTP ${response.status}`);
  const source = await response.text();
  const factory = new Function(`${source}\nreturn linux;`) as () => unknown;
  const runtime = factory();
  if (typeof runtime !== "function") {
    throw new Error("Pinned Linux-WASM browser runtime did not expose linux()");
  }
  return runtime as NeruLinuxBrowserRuntime;
}

export async function bootNeruBrowser(
  options: NeruBrowserBootOptions = {},
): Promise<NeruBrowserMachine> {
  const isolated = options.crossOriginIsolated ?? globalThis.crossOriginIsolated;
  if (isolated !== true) {
    throw new Error(
      "NERU web requires cross-origin isolation (COOP same-origin and COEP require-corp)",
    );
  }
  if (typeof SharedArrayBuffer !== "function") {
    throw new Error("NERU web requires SharedArrayBuffer support");
  }

  installArrayBufferTransfer();
  const plan = planNeruBrowserBoot(options);
  if (!plan.initramfsUrl && !plan.filesystemEndpoint) {
    throw new Error("Kernel-only NERU web boot requires a live filesystem endpoint");
  }
  Object.defineProperty(globalThis, "__neruFilesystemConfig", {
    configurable: true,
    value: plan.filesystemEndpoint
      ? {
          kind: "authority",
          endpoint: plan.filesystemEndpoint,
          token: plan.filesystemToken,
          clientId: plan.filesystemClientId,
        }
      : null,
  });

  const fetcher = options.fetcher ?? fetch;
  const runtimePromise = options.runtime ?? loadNeruLinuxBrowserRuntime(plan.runtimeUrl, fetcher);
  const kernelResponse = await fetcher(plan.kernelUrl, { cache: "no-store" });
  if (!kernelResponse.ok) throw new Error(`${plan.kernelUrl.pathname}: HTTP ${kernelResponse.status}`);
  const initramfs = plan.initramfsUrl
    ? await fetcher(plan.initramfsUrl, { cache: "no-store" }).then(async response => {
        if (!response.ok) throw new Error(`${plan.initramfsUrl!.pathname}: HTTP ${response.status}`);
        return await response.arrayBuffer();
      })
    : new ArrayBuffer(0);

  const kernel = await (options.compileKernel ?? WebAssembly.compile)(
    await kernelResponse.arrayBuffer(),
  );
  const machine = await (await runtimePromise)(
    plan.workerUrl.href,
    plan.variant,
    kernel,
    plan.commandLine,
    initramfs,
    options.log ?? (() => {}),
    options.write ?? (() => {}),
  );

  let active = true;
  return {
    keyInput(data: string): void {
      if (active) machine.key_input(data);
    },
    terminate(): void {
      active = false;
    },
  };
}
