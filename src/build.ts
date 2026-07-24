import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { artifactPaths, neruPackageRoot, neruVariant } from "./runtime.js";
import type {
  NeruArtifactPaths,
  NeruPocImageBuildOptions,
  NeruRuntimeBuildOptions,
} from "./types.js";

const cleanEnvironment = (): Record<string, string> => Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);

async function runBuilder(
  builder: string,
  environment: Record<string, string>,
  label: string,
): Promise<void> {
  const packageRoot = neruPackageRoot();
  const code = await new Promise<number>((resolveRun, reject) => {
    const child = spawn("bash", [builder], {
      stdio: "inherit",
      env: environment,
      cwd: packageRoot,
    });
    child.once("error", reject);
    child.once("close", (status: number | null) => resolveRun(status ?? 1));
  });
  if (code !== 0) throw new Error(`${label} failed with status ${code}`);
}

async function verifyCommonArtifacts(output: NeruArtifactPaths): Promise<void> {
  await Promise.all([
    access(output.kernel, constants.R_OK),
    access(output.browserRuntime, constants.R_OK),
    access(output.browserWorker, constants.R_OK),
    access(output.manifest, constants.R_OK),
  ]);
}

/** Build the kernel-only NERU runtime. It contains no initramfs or userspace. */
export async function buildNeruRuntime(
  options: NeruRuntimeBuildOptions = {},
): Promise<NeruArtifactPaths> {
  const packageRoot = neruPackageRoot();
  const variant = neruVariant(options.variant);
  const output = artifactPaths(
    options.output ?? join(packageRoot, "dist", `neru-runtime-${variant}`),
  );
  const environment: Record<string, string> = {
    ...cleanEnvironment(),
    NERU_OUTPUT: output.root,
    LW_VARIANT: variant,
  };
  if (options.workspace) environment.LW_WORKSPACE = resolve(options.workspace);
  if (options.rebuildLinux) environment.NERU_REBUILD_LINUX = "1";

  await runBuilder(
    join(packageRoot, "scripts", "build-runtime.sh"),
    environment,
    "NERU kernel-only runtime build",
  );
  await verifyCommonArtifacts(output);
  return output;
}

/**
 * Build the original proof-of-concept image that embeds a copied mikuOS
 * userspace. Kept for comparison and regression testing only.
 */
export async function buildNeruImage(
  options: NeruPocImageBuildOptions,
): Promise<NeruArtifactPaths> {
  const packageRoot = neruPackageRoot();
  const userland = resolve(options.userland);
  await access(userland, constants.R_OK);
  const variant = neruVariant(options.variant);
  const output = artifactPaths(
    options.output ?? join(packageRoot, "dist", `neru-poc-${variant}`),
  );
  const environment: Record<string, string> = {
    ...cleanEnvironment(),
    NERU_USERLAND: userland,
    NERU_OUTPUT: output.root,
    LW_VARIANT: variant,
  };
  if (options.workspace) environment.LW_WORKSPACE = resolve(options.workspace);
  if (options.rebuildLinux) environment.NERU_REBUILD_LINUX = "1";

  await runBuilder(
    join(packageRoot, "scripts", "build-image.sh"),
    environment,
    "NERU proof-of-concept image build",
  );
  await verifyCommonArtifacts(output);
  await access(output.initramfs, constants.R_OK);
  return output;
}
