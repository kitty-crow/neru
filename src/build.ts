import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { artifactPaths, neruPackageRoot, neruVariant } from "./runtime.js";
import type { NeruArtifactPaths, NeruBuildOptions } from "./types.js";

export async function buildNeruImage(
  options: NeruBuildOptions,
): Promise<NeruArtifactPaths> {
  const packageRoot = neruPackageRoot();
  const builder = join(packageRoot, "scripts", "build-image.sh");
  const userland = resolve(options.userland);
  await access(userland, constants.R_OK);
  const variant = neruVariant(options.variant);
  const output = artifactPaths(
    options.output ?? join(packageRoot, "dist", `neru-${variant}`),
  );
  const environment: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    NERU_USERLAND: userland,
    NERU_OUTPUT: output.root,
    LW_VARIANT: variant,
  };
  if (options.workspace) environment.LW_WORKSPACE = resolve(options.workspace);
  if (options.rebuildLinux) environment.NERU_REBUILD_LINUX = "1";

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

  await Promise.all([
    access(output.kernel, constants.R_OK),
    access(output.initramfs, constants.R_OK),
    access(output.browserRuntime, constants.R_OK),
    access(output.browserWorker, constants.R_OK),
    access(output.manifest, constants.R_OK),
  ]);
  return output;
}
