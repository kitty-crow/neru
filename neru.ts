import {
  artifactPaths,
  buildNeruImage,
  buildNeruRuntime,
  bootNeru,
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
    "Usage: bun neru.ts [--output DIR] [--variant NAME] [--fs-endpoint URL] [--boot]\n" +
    "       bun neru.ts --artifact-root DIR --fs-endpoint URL --boot --skip-build\n" +
    "       bun neru.ts --artifact-root DIR --probe\n" +
    "       bun neru.ts --poc-image --userland DIR [--output DIR] [--boot]\n" +
    "\n" +
    "The default build contains only vmlinux.wasm and its host runtime. Linux mounts\n" +
    "the live mikuOS userspace as mikuosfs and starts /sbin/nemunemu from that root.\n" +
    "Use --poc-image only to reproduce the original embedded-userspace experiment.\n",
  );
  process.exit(0);
}

const variant = option("--variant") as "wasm32_nommu" | "wasm64_nommu" | undefined;
const userland = option("--userland") ?? process.env.NERU_USERLAND;
const output = option("--output") ?? option("--artifact-root") ?? process.env.NERU_ARTIFACT_ROOT;
const skipBuild = args.includes("--skip-build");
const pocImage = args.includes("--poc-image");

let artifactRoot = output;
if (!skipBuild) {
  const common = {
    ...(output ? { output } : {}),
    ...(variant ? { variant } : {}),
    ...(option("--workspace") ? { workspace: option("--workspace")! } : {}),
    rebuildLinux: args.includes("--rebuild-linux"),
  };
  const artefacts = pocImage
    ? await buildNeruImage({
        ...common,
        userland: userland ?? (() => { throw new Error("--poc-image requires --userland DIR"); })(),
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
  ...(option("--fs-endpoint") ? { filesystemEndpoint: option("--fs-endpoint")! } : {}),
  ...(option("--fs-token") ? { filesystemToken: option("--fs-token")! } : {}),
  ...(option("--fs-client-id") ? { filesystemClientId: option("--fs-client-id")! } : {}),
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
