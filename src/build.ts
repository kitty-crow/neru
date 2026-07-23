import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { FetchSharedFsClient } from "./fs/client.js";
import { materialiseSnapshot } from "./materialize.js";
import { artifactPaths, neruPackageRoot, neruVariant } from "./runtime.js";
import type { NeruArtifactPaths, NeruBuildOptions } from "./types.js";

export async function buildNeruImage(
  options: NeruBuildOptions,
): Promise<NeruArtifactPaths> {
  const packageRoot = neruPackageRoot();
  const builder = join(packageRoot, "scripts", "build-image.sh");
  const variant = neruVariant(options.variant);
  const output = artifactPaths(
    options.output ?? join(packageRoot, "dist", `neru-${variant}`),
  );
  const sharedFs = options.sharedFs ?? process.env.MIKUOS_FS_URL;
  const sharedFsToken = options.sharedFsToken ?? process.env.MIKUOS_FS_TOKEN;
  let userland = resolve(options.userland);
  let checkpointGeneration = 0;
  let checkpointChecksum = "bootstrap-source";
  let cleanup: (() => Promise<void>) | undefined;

  if (sharedFs) {
    const client = new FetchSharedFsClient(sharedFs, {
      clientId: `neru-builder-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
      ...(sharedFsToken ? { token: sharedFsToken } : {}),
    });
    try {
      await client.connect();
      const materialised = await materialiseSnapshot(await client.snapshot());
      userland = materialised.root;
      checkpointGeneration = materialised.generation;
      checkpointChecksum = materialised.checksum;
      cleanup = materialised.cleanup;
    } finally {
      await client.close().catch(() => undefined);
    }
  } else {
    await access(userland, constants.R_OK);
  }

  const environment: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    NERU_USERLAND: userland,
    NERU_OUTPUT: output.root,
    NERU_CHECKPOINT_GENERATION: String(checkpointGeneration),
    NERU_CHECKPOINT_CHECKSUM: checkpointChecksum,
    LW_VARIANT: variant,
    ...(sharedFs ? { MIKUOS_FS_URL: sharedFs } : {}),
    ...(sharedFsToken ? { MIKUOS_FS_TOKEN: sharedFsToken } : {}),
  };
  if (options.workspace) environment.LW_WORKSPACE = resolve(options.workspace);
  if (options.rebuildLinux) environment.NERU_REBUILD_LINUX = "1";

  try {
    const code = await new Promise<number>((resolveRun, reject) => {
      const child = spawn("bash", [builder], {
        stdio: "inherit",
        env: environment,
        cwd: packageRoot,
      });
      child.once("error", reject);
      child.once("close", (status: number | null) => resolveRun(status ?? 1));
    });
    if (code !== 0) throw new Error(`NERU image build failed with status ${code}`);
  } finally {
    await cleanup?.();
  }

  await Promise.all([
    access(output.kernel, constants.R_OK),
    access(output.initramfs, constants.R_OK),
    access(output.browserRuntime, constants.R_OK),
    access(output.browserWorker, constants.R_OK),
    access(output.manifest, constants.R_OK),
  ]);
  return output;
}
