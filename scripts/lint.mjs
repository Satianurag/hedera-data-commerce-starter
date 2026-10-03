import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const nextOnly = process.argv.includes("--next");
const paths = nextOnly
  ? ["packages/nextjs"]
  : ["packages", "scripts", "deploy", "e2e", "playwright.config.ts", "eslint.config.mjs"];
for (const [binary, args] of [
  ["eslint", ["--config", "eslint.config.mjs", "packages/nextjs"]],
  ["oxlint", ["--disable-nested-config", "--config", ".oxlintrc.json", ...paths]],
]) {
  const manifest = require(`${binary}/package.json`);
  const entry = join(dirname(require.resolve(`${binary}/package.json`)), manifest.bin[binary]);
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
