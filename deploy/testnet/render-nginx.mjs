import { readFileSync } from "node:fs";

const [host, fullchain, privateKey] = process.argv.slice(2);
const labels = host?.split(".") ?? [];
if (
  labels.length < 2 ||
  host.length > 253 ||
  labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
) {
  throw new Error(
    "Usage: render-nginx.mjs <public DNS host> <absolute fullchain path> <absolute private-key path>",
  );
}
for (const path of [fullchain, privateKey]) {
  if (!path || !/^\/[A-Za-z0-9_./-]+$/.test(path) || path.split("/").includes("..")) {
    throw new Error("Certificate paths must be absolute and contain no spaces or parent traversal");
  }
}
if (process.argv.length !== 5) throw new Error("Exactly three arguments are required");
const template = readFileSync(new URL("./nginx.conf.template", import.meta.url), "utf8");
process.stdout.write(
  template
    .replaceAll("__PUBLIC_HOST__", host)
    .replaceAll("__TLS_FULLCHAIN__", fullchain)
    .replaceAll("__TLS_PRIVATE_KEY__", privateKey),
);
