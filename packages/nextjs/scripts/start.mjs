import { spawn } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const app = fileURLToPath(new URL("..", import.meta.url));
const standalone = join(app, ".next", "standalone");
const nested = join(standalone, "packages", "nextjs");
const server = existsSync(join(nested, "server.js")) ? nested : standalone;
const staticSource = join(app, ".next", "static");
if (!existsSync(join(server, "server.js")) || !existsSync(staticSource)) {
  console.error("No production build found. Run: npm run build");
  process.exit(1);
}

cpSync(staticSource, join(server, ".next", "static"), { recursive: true, force: true });
const publicSource = join(app, "public");
if (existsSync(publicSource))
  cpSync(publicSource, join(server, "public"), { recursive: true, force: true });

const child = spawn(process.execPath, [join(server, "server.js")], {
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: process.env.PORT ?? "3000",
    HOSTNAME: process.env.HOST ?? "127.0.0.1",
  },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
