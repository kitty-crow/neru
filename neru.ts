import { buildNeruImage, bootNeru, probeNeru } from "./src/index.js";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const joined = args.find(argument => argument.startsWith(`${name}=`));
  if (joined) return joined.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    "Usage: bun neru.ts --userland DIR [--output DIR] [--variant NAME] [--boot]\n" +
    "       bun neru.ts --artifact-root DIR --boot --skip-build\n" +
    "       bun neru.ts --artifact-root DIR --probe\n",
  );
  process.exit(0);
}

const variant = option("--variant") as "wasm32_nommu" | "wasm64_nommu" | undefined;
const userland = option("--userland") ?? process.env.NERU_USERLAND;
const output = option("--output") ?? option("--artifact-root") ?? process.env.NERU_ARTIFACT_ROOT;
const skipBuild = args.includes("--skip-build");

let artifactRoot = output;
if (!skipBuild) {
  if (!userland) throw new Error("NERU build requires --userland DIR or NERU_USERLAND");
  const artefacts = await buildNeruImage({
    userland,
    ...(output ? { output } : {}),
    ...(variant ? { variant } : {}),
    ...(option("--workspace") ? { workspace: option("--workspace")! } : {}),
    rebuildLinux: args.includes("--rebuild-linux"),
  });
  artifactRoot = artefacts.root;
  process.stdout.write(`NERU image: ${artefacts.root}\n`);
}

if (args.includes("--probe")) {
  const result = await probeNeru({ ...(artifactRoot ? { artifactRoot } : {}) });
  process.stdout.write(`Linux runtime: ${result.executable}\n`);
  process.stdout.write(`Linux kernel: ${result.kernel}\n`);
  process.stdout.write(`NERU image: ${result.initramfs}\n`);
} else if (args.includes("--boot")) {
  process.exitCode = await bootNeru({ ...(artifactRoot ? { artifactRoot } : {}) });
}
