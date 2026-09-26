import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform === "win32" ? "win32" : null;
const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
if (!platform || !architecture || (platform === "win32" && architecture === "arm64")) {
  throw new Error(`Foundry does not support ${process.platform}/${process.arch}`);
}

const binaryName = platform === "win32" ? "forge.exe" : "forge";
let binary;
try {
  binary = require.resolve(`@foundry-rs/forge-${platform}-${architecture}/bin/${binaryName}`);
} catch {
  const packagePath = require.resolve("@foundry-rs/forge/package.json");
  binary = join(dirname(packagePath), "..", "dist", binaryName);
  if (!existsSync(binary)) throw new Error("Foundry executable was not installed");
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exitCode = result.status ?? 1;
