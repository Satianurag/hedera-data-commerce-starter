import { cpSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../..", import.meta.url));
if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("Stage this testnet app on Linux x64; better-sqlite3 includes a native binary");
}
const app = join(root, "packages", "nextjs");
const standalone = join(app, ".next", "standalone");
const nested = join(standalone, "packages", "nextjs");
const server = existsSync(join(nested, "server.js")) ? nested : standalone;
const staticSource = join(app, ".next", "static");
if (!existsSync(join(server, "server.js")) || !existsSync(staticSource)) {
  throw new Error("Build the Next.js standalone app before staging it");
}
const staticTarget = join(server, ".next", "static");
mkdirSync(staticTarget, { recursive: true });
cpSync(staticSource, staticTarget, { recursive: true, force: true });
const publicSource = join(app, "public");
if (existsSync(publicSource))
  cpSync(publicSource, join(server, "public"), { recursive: true, force: true });
console.log(`Staged standalone app at ${standalone}`);
console.log(`Built on Linux ${process.arch} with Node ${process.version}`);
console.log(`Run with HOSTNAME=127.0.0.1 PORT=3000 node ${join(server, "server.js")}`);
