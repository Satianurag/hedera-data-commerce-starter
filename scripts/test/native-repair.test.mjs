import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { repairNative } from "../rebuild-native.mjs";

const require = createRequire(import.meta.url);
const installed = dirname(require.resolve("better-sqlite3/package.json"));

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "native-repair-regression-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("healthy installed addon executes real SQL without a package manager or rebuild", () => {
  // Passing no package-manager executable makes any attempted download/build fail this test.
  repairNative(installed, undefined);
});

test("unreviewed addon versions fail before build or package mutation", (t) => {
  const directory = temporary(t);
  const metadata = JSON.stringify({ name: "better-sqlite3", version: "99.0.0" });
  writeFileSync(join(directory, "package.json"), metadata);
  assert.throws(() => repairNative(directory, undefined), /review changed package versions/);
  assert.deepEqual(readdirSync(directory), ["package.json"]);
  assert.equal(readFileSync(join(directory, "package.json"), "utf8"), metadata);
});

test("failed source build preserves a corrupt prebuild and uses the selected Node runtime", (t) => {
  const directory = temporary(t);
  const fixture = join(directory, "better-sqlite3");
  mkdirSync(fixture);
  cpSync(join(installed, "lib"), join(fixture, "lib"), { recursive: true });
  cpSync(join(installed, "package.json"), join(fixture, "package.json"));
  const { getPrebuildPath } = require(join(installed, "lib/binding.js"));
  const prebuildName = getPrebuildPath()
    ? basename(getPrebuildPath())
    : `${process.platform}-${process.arch}.node`;
  const prebuildDirectory = join(fixture, "prebuilds");
  mkdirSync(prebuildDirectory);
  const prebuild = join(prebuildDirectory, prebuildName);
  const original = Buffer.from("deliberately invalid native addon; preserve these bytes\n");
  writeFileSync(prebuild, original);
  const attempted = join(directory, "attempt.json");
  const npm = join(directory, "failing-npm.cjs");
  writeFileSync(
    npm,
    `const { spawnSync } = require('node:child_process');
    const child = spawnSync('node', ['-p', 'process.version'], { encoding:'utf8' });
    require('node:fs').writeFileSync(${JSON.stringify(attempted)}, JSON.stringify({ childStatus:child.status, node:child.stdout.trim() }));
    process.exit(23);\n`,
  );
  const fakeBin = join(directory, "fake-bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "node"), "#!/bin/sh\nprintf wrong-runtime\nexit 31\n");
  chmodSync(join(fakeBin, "node"), 0o700);
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
    assert.throws(() => repairNative(fixture, npm), /Native source build failed/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  assert.deepEqual(readFileSync(prebuild), original);
  assert.deepEqual(readdirSync(prebuildDirectory), [prebuildName]);
  const child = JSON.parse(readFileSync(attempted, "utf8"));
  assert.equal(child.childStatus, 0);
  assert.equal(child.node, process.version);
});

test("failed forced rebuild preserves a previously working source-only addon", (t) => {
  const directory = temporary(t);
  const fixture = join(directory, "better-sqlite3");
  mkdirSync(fixture);
  cpSync(join(installed, "lib"), join(fixture, "lib"), { recursive: true });
  cpSync(join(installed, "package.json"), join(fixture, "package.json"));
  const { getPrebuildPath } = require(join(installed, "lib/binding.js"));
  const source = getPrebuildPath() ?? join(installed, "build/Release/better_sqlite3.node");
  const destination = join(fixture, "build/Release/better_sqlite3.node");
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
  const original = readFileSync(destination);
  function sqlProbe() {
    return spawnSync(
      process.execPath,
      [
        "-e",
        "const db = new (require(process.argv[1]))(':memory:'); if (db.prepare('SELECT 1 value').get().value !== 1) process.exit(9); db.close();",
        fixture,
      ],
      { encoding: "utf8" },
    );
  }
  assert.equal(sqlProbe().status, 0, "fixture must begin with a real working source-only addon");
  const npm = join(directory, "clean-then-fail.cjs");
  // Actual node-gyp 13 rebuild performs clean before configure/build. Reproduce
  // that failure boundary without downloading a compiler in the default suite.
  writeFileSync(
    npm,
    `const fs = require('node:fs'); fs.rmSync(${JSON.stringify(join(fixture, "build"))}, {recursive:true, force:true}); fs.mkdirSync(${JSON.stringify(dirname(destination))}, {recursive:true}); fs.writeFileSync(${JSON.stringify(destination)}, 'partial failed build'); process.exit(23);\n`,
  );
  assert.throws(() => repairNative(fixture, npm, { force: true }), /Native source build failed/);
  assert.equal(sqlProbe().status, 0, "failed optional rebuild must preserve the working addon");
  assert.deepEqual(readFileSync(destination), original);
  const failed = readdirSync(fixture).filter((name) => name.startsWith("build.failed-repair-"));
  assert.equal(failed.length, 1);
  assert.equal(
    readFileSync(join(fixture, failed[0], "Release/better_sqlite3.node"), "utf8"),
    "partial failed build",
  );
});
