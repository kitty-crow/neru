import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  NeruArtifactPaths,
  NeruBootOptions,
  NeruBootPlan,
  NeruProbeResult,
  NeruVariant,
} from "./types.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = basename(dirname(moduleDirectory)) === "dist"
  ? resolve(moduleDirectory, "../..")
  : resolve(moduleDirectory, "..");

export const neruPackageRoot = (): string => packageRoot;

export const neruVariant = (explicit?: string): NeruVariant => {
  const value = explicit ?? process.env.NERU_LINUX_VARIANT ?? "wasm32_nommu";
  if (value !== "wasm32_nommu" && value !== "wasm64_nommu") {
    throw new Error(`Unsupported NERU Linux variant: ${value}`);
  }
  return value;
};

export function resolveArtifactRoot(explicit?: string): string {
  const configured = explicit ?? process.env.NERU_ARTIFACT_ROOT;
  return configured
    ? resolve(configured)
    : join(packageRoot, "dist", `neru-runtime-${neruVariant()}`);
}

export function artifactPaths(root = resolveArtifactRoot()): NeruArtifactPaths {
  const resolved = resolve(root);
  return {
    root: resolved,
    kernel: join(resolved, "vmlinux.wasm"),
    initramfs: join(resolved, "initramfs.cpio.gz"),
    browserRuntime: join(resolved, "linux.js"),
    browserWorker: join(resolved, "linux-worker.js"),
    manifest: join(resolved, "manifest.json"),
  };
}

export function resolveLinuxRuntime(explicit?: string): string {
  const configured = explicit ?? process.env.NERU_LINUX_RUNTIME;
  return configured
    ? resolve(configured)
    : join(packageRoot, "bin", "neru-linux-runtime.mjs");
}

const cleanEnvironment = (
  additions: Readonly<Record<string, string>>,
): Record<string, string> => {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...additions };
};

export function planNeruBoot(options: NeruBootOptions = {}): NeruBootPlan {
  const artefacts = artifactPaths(options.artifactRoot);
  const executable = resolveLinuxRuntime(options.linuxRuntime);
  const kernel = resolve(options.kernel ?? artefacts.kernel);
  const initramfs = options.initramfs ? resolve(options.initramfs) : undefined;
  const bridgeEnvironment: Record<string, string> = {};
  if (options.filesystemRoot) bridgeEnvironment.NERU_FS_ROOT = resolve(options.filesystemRoot);
  if (options.filesystemEndpoint) bridgeEnvironment.NERU_FS_ENDPOINT = options.filesystemEndpoint;
  if (options.filesystemToken) bridgeEnvironment.NERU_FS_TOKEN = options.filesystemToken;
  if (options.filesystemClientId) bridgeEnvironment.NERU_FS_CLIENT_ID = options.filesystemClientId;
  return {
    executable,
    argv: [
      "--kernel",
      kernel,
      ...(initramfs ? ["--initramfs", initramfs] : []),
      ...(options.argv ?? []),
    ],
    environment: cleanEnvironment({
      ...bridgeEnvironment,
      ...(options.environment ?? {}),
    }),
    kernel,
    ...(initramfs ? { initramfs } : {}),
  };
}

export async function probeNeru(
  options: NeruBootOptions = {},
): Promise<NeruProbeResult> {
  const plan = planNeruBoot(options);
  await access(plan.executable, constants.X_OK);
  await access(plan.kernel, constants.R_OK);
  if (plan.initramfs) await access(plan.initramfs, constants.R_OK);
  return {
    executable: plan.executable,
    kernel: plan.kernel,
    ...(plan.initramfs ? { initramfs: plan.initramfs } : {}),
  };
}

export async function bootNeru(options: NeruBootOptions = {}): Promise<number> {
  const plan = planNeruBoot(options);
  await probeNeru(options);
  return await new Promise((resolveRun, reject) => {
    const child = spawn(plan.executable, plan.argv, {
      stdio: "inherit",
      env: plan.environment,
    });
    child.once("error", reject);
    child.once("close", (code: number | null) => resolveRun(code ?? 1));
  });
}
