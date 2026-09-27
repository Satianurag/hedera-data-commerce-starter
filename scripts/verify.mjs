import { spawnSync } from "node:child_process";

// Argument arrays also survive the Scaffold-HBAR CLI's npm text rewriting.
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this check with npm run verify");

for (const args of [
  ["test"],
  ["run", "typecheck"],
  ["run", "lint"],
  ["ls", "--all"],
  ["audit", "--audit-level=low"],
]) {
  const result = spawnSync(process.execPath, [npm, ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
