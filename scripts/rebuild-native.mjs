import { spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const nodeGypVersion = "13.1.0";

function probe(packagePath, nativeBinding) {
  const code = `const Database = require(process.argv[1]);
    const db = new Database(':memory:', process.argv[2] ? {nativeBinding:process.argv[2]} : {});
    if (db.prepare('SELECT 1 AS value').get().value !== 1) throw new Error('SQLite probe failed');
    db.close();`;
  return spawnSync(
    process.execPath,
    ["-e", code, packagePath, ...(nativeBinding ? [nativeBinding] : [])],
    {
      encoding: "utf8",
    },
  );
}

export function repairNative(packagePath, npm, { force = false } = {}) {
  const metadata = require(join(packagePath, "package.json"));
  if (metadata.name !== "better-sqlite3" || metadata.version !== "13.0.3") {
    throw new Error(
      "Native repair is verified for pinned better-sqlite3 13.0.3; review changed package versions before rebuilding",
    );
  }
  const original = probe(packagePath);
  if (!force && original.status === 0) {
    console.log("better-sqlite3 loads and executes SQL on this Node runtime; no rebuild needed.");
    return;
  }
  if (!npm) throw new Error("Run this with: npm run rebuild:native");
  // node-gyp rebuild starts by deleting build/. Preserve a working local addon
  // before that clean step, including when --force is used without a prebuild.
  const build = join(packagePath, "build");
  const previousBuild = existsSync(build) ? `${build}.before-repair-${randomUUID()}` : undefined;
  if (previousBuild) renameSync(build, previousBuild);
  let backup;
  let prebuilt;
  try {
    // v13 ships Node-API prebuilds and disables npm's implicit node-gyp hook.
    // A generic package rebuild can report success without producing an addon.
    const result = spawnSync(
      process.execPath,
      [
        npm,
        "exec",
        "--yes",
        `--package=node-gyp@${nodeGypVersion}`,
        "--",
        "node-gyp",
        "rebuild",
        "--release",
        `--directory=${packagePath}`,
        "--force_build=1",
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        "Native source build failed. Install Python and a C/C++ toolchain (Xcode Command Line Tools on macOS, make/GCC on Linux), then retry; application data was not changed.",
      );
    const compiled = join(packagePath, "build", "Release", "better_sqlite3.node");
    if (!existsSync(compiled) || probe(packagePath, compiled).status !== 0) {
      throw new Error("Built addon did not load and execute SQL; existing prebuild was retained");
    }
    const { getPrebuildPath } = require(join(packagePath, "lib", "binding.js"));
    prebuilt = getPrebuildPath();
    // The loader prefers a shipped prebuild over a locally compiled addon.
    // Preserve it before selecting the verified local build, including corruption.
    if (prebuilt) {
      backup = `${prebuilt}.before-repair-${randomUUID()}`;
      renameSync(prebuilt, backup);
    }
    if (probe(packagePath).status !== 0) {
      throw new Error("Default addon selection still fails");
    }
    console.log(
      `Native source build and default SQLite load verified.${backup ? ` Previous prebuild retained at ${backup}` : ""}${previousBuild ? ` Previous build retained at ${previousBuild}` : ""}`,
    );
  } catch (error) {
    if (backup) renameSync(backup, prebuilt);
    if (previousBuild) {
      if (existsSync(build)) renameSync(build, `${build}.failed-repair-${randomUUID()}`);
      renameSync(previousBuild, build);
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--force"))
    throw new Error("Usage: npm run rebuild:native -- [--force]");
  const packagePath = dirname(require.resolve("better-sqlite3/package.json"));
  repairNative(packagePath, process.env.npm_execpath, { force: args.includes("--force") });
}
