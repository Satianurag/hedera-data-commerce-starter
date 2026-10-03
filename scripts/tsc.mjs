import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// The package manager can hoist the compatibility API's transitive `tsc` over the native one.
// Resolve the pinned native compiler explicitly instead of depending on bin order.
const require = createRequire(import.meta.url);
const manifest = require.resolve("@typescript/native/package.json");
const compiler = join(dirname(manifest), require(manifest).bin.tsc);
const result = spawnSync(process.execPath, [compiler, ...process.argv.slice(2)], {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
