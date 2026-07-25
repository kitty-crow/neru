import {
  artifactPaths,
  buildNeruImage,
  buildNeruRuntime,
  bootNeru,
  prepareNeruLiveUserspace,
  probeNeru,
} from "./src/index.js";

const args = process.argv.slice(2);

const option = (name: string): string | undefined => {
  const joined = args.find(argument => argument.startsWith(`${name}=`));
  if (joined) return joined.slice(name.length + 1);

  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    "Usage: bun neru.ts --fs-root DIR [--boot]\n" +
    "       bun neru.ts --fs-endpoint URL [--boot]\n" +
    "       bun neru.ts --artifact-root DIR --fs-root DIR --boot --skip-build\n" +
    "       bun neru.ts --artifact-root DIR --probe\n" +
    "       bun neru.ts --poc-image --userland DIR [--output DIR] [--boot]\n" +
    "\n" +
    "Normal live-root launches automatically prepare the selected mikuOS root\n" +
    "and reuse current NEMUNEMU, BusyBox and Linux-WASM artefacts.\n" +
    "\n" +
    "The default build contains only vmlinux.wasm and its host runtime. Linux\n" +
    "mounts the selected mikuOS root as mikuosfs and starts /sbin/nemunemu.\n" +
    "Use --poc-image only to reproduce the original embedded-userspace test.\n",
  );
  process.exit(0);
}

const variant = option("--variant") as
  | "wasm32_nommu"
  | "wasm64_nommu"
  | undefined;

const userland = option("--userland") ?? process.env.NERU_USERLAND;
const output =
  option("--output")
  ?? option("--artifact-root")
  ?? process.env.NERU_ARTIFACT_ROOT;

const workspace = option("--workspace");
const filesystemRoot = option("--fs-root");
const filesystemEndpoint = option("--fs-endpoint");
const skipBuild = args.includes("--skip-build");
const pocImage = args.includes("--poc-image");

let artifactRoot = output;

if (!skipBuild) {
  const common = {
    ...(output ? { output } : {}),
    ...(variant ? { variant } : {}),
    ...(workspace ? { workspace } : {}),
    rebuildLinux: args.includes("--rebuild-linux"),
  };

  if (!pocImage && filesystemRoot) {
    await prepareNeruLiveUserspace(filesystemRoot, {
      ...(variant ? { variant } : {}),
      ...(workspace ? { workspace } : {}),
    });
  }

  const artefacts = pocImage
    ? await buildNeruImage({
        ...common,
        userland: userland ?? (() => {
          throw new Error("--poc-image requires --userland DIR");
        })(),
      })
    : await buildNeruRuntime(common);

  artifactRoot = artefacts.root;

  process.stdout.write(
    pocImage
      ? `NERU proof-of-concept image: ${artefacts.root}\n`
      : `NERU kernel-only runtime: ${artefacts.root}\n`,
  );
}

const bootOptions = {
  ...(artifactRoot ? { artifactRoot } : {}),
  ...(pocImage && artifactRoot
    ? { initramfs: artifactPaths(artifactRoot).initramfs }
    : {}),
  ...(filesystemRoot ? { filesystemRoot } : {}),
  ...(filesystemEndpoint ? { filesystemEndpoint } : {}),
  ...(option("--fs-token")
    ? { filesystemToken: option("--fs-token")! }
    : {}),
  ...(option("--fs-client-id")
    ? { filesystemClientId: option("--fs-client-id")! }
    : {}),
};

if (args.includes("--probe")) {
  const result = await probeNeru(bootOptions);
  process.stdout.write(`Linux runtime: ${result.executable}\n`);
  process.stdout.write(`Linux kernel: ${result.kernel}\n`);
  process.stdout.write(
    result.initramfs
      ? `Proof-of-concept initramfs: ${result.initramfs}\n`
      : "Initramfs: none\n",
  );
} else if (args.includes("--boot")) {
  process.exitCode = await bootNeru(bootOptions);
}
