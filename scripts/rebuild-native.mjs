import { spawnSync } from "node:child_process";

// Rebuilds better-sqlite3 for the active Node runtime after a version or OS change.
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this with: npm run rebuild:native");
const result = spawnSync(process.execPath, [npm, "rebuild", "better-sqlite3"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
