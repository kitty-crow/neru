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
  initramfsUrl?: string | URL;
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
  initramfsUrl: URL;
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
  return {
    runtimeUrl: absolute(options.runtimeUrl ?? "linux.js", base),
    workerUrl: absolute(options.workerUrl ?? "linux-worker.js", base),
    kernelUrl: absolute(options.kernelUrl ?? "vmlinux.wasm", base),
    initramfsUrl: absolute(options.initramfsUrl ?? "initramfs.cpio.gz", base),
    variant,
    commandLine: options.commandLine ??
      "maxcpus=3 nohz_full=0,2-63 rcu_nocbs=0,2-63 " +
      "root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0",
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
  const fetcher = options.fetcher ?? fetch;
  const [runtime, kernelResponse, initramfsResponse] = await Promise.all([
    options.runtime ?? loadNeruLinuxBrowserRuntime(plan.runtimeUrl, fetcher),
    fetcher(plan.kernelUrl, { cache: "no-store" }),
    fetcher(plan.initramfsUrl, { cache: "no-store" }),
  ]);
  if (!kernelResponse.ok) throw new Error(`${plan.kernelUrl.pathname}: HTTP ${kernelResponse.status}`);
  if (!initramfsResponse.ok) throw new Error(`${plan.initramfsUrl.pathname}: HTTP ${initramfsResponse.status}`);

  const kernel = await (options.compileKernel ?? WebAssembly.compile)(
    await kernelResponse.arrayBuffer(),
  );
  const machine = await runtime(
    plan.workerUrl.href,
    plan.variant,
    kernel,
    plan.commandLine,
    await initramfsResponse.arrayBuffer(),
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
