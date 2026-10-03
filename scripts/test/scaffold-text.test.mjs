import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checker = fileURLToPath(new URL("../check-scaffold-text.mjs", import.meta.url));

test("scaffold text check covers new files and whole-file rewrites while tolerating deleted files", () => {
  const work = mkdtempSync(join(tmpdir(), "scaffold-text-test-"));
  const run = (command, args) => spawnSync(command, args, { cwd: work, encoding: "utf8" });
  const check = () => run(process.execPath, [checker]);
  try {
    assert.equal(run("git", ["init", "--quiet"]).status, 0);
    writeFileSync(join(work, "deleted.md"), "gone\n");
    assert.equal(run("git", ["add", "deleted.md"]).status, 0);
    rmSync(join(work, "deleted.md"));
    writeFileSync(join(work, "new.md"), ["npm", "audit"].join(" "));
    let result = check();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /new\.md:1/);

    writeFileSync(join(work, "new.md"), ["npm", "audit"].join("\n"));
    result = check();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /new\.md:1/);

    writeFileSync(join(work, "new.md"), "npm run verify\n");
    writeFileSync(join(work, ".gitignore"), "# npm\n\nnode_modules/\n");
    result = check();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /\.gitignore:1/);

    writeFileSync(join(work, ".gitignore"), "node_modules/\nignored.md\n");
    writeFileSync(join(work, "ignored.md"), ["npm", "audit"].join(" "));
    result = check();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 authored files/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
