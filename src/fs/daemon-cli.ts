#!/usr/bin/env node
import { startSharedFsDaemon } from "./daemon.js";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const joined = args.find(value => value.startsWith(`${name}=`));
  if (joined) return joined.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    "Usage: neru-fs --store DIR [--host ADDRESS] [--port NUMBER] [--token TOKEN] [--seed SNAPSHOT.json]\n",
  );
  process.exit(0);
}
const store = option("--store") ?? process.env.MIKUOS_FS_STORE;
if (!store) throw new Error("neru-fs requires --store DIR or MIKUOS_FS_STORE");
const hostname = option("--host") ?? process.env.MIKUOS_FS_HOST;
const portText = option("--port") ?? process.env.MIKUOS_FS_PORT;
const token = option("--token") ?? process.env.MIKUOS_FS_TOKEN;
const seed = option("--seed");
const daemon = await startSharedFsDaemon({
  store,
  ...(hostname ? { hostname } : {}),
  ...(portText ? { port: Number(portText) } : {}),
  ...(token ? { token } : {}),
  ...(seed ? { seed } : {}),
});
process.stdout.write(`${daemon.url.href}\n`);
let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await daemon.close();
};
process.once("SIGINT", () => void close().then(() => process.exit(130)));
process.once("SIGTERM", () => void close().then(() => process.exit(143)));
