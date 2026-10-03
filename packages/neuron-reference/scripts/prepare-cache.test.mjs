import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  checkCheckout,
  lockCache,
  openCache,
  publishBuild,
  restoreManifests,
  synchronizeOverlay,
  treeManifest,
  writeAtomic,
} from "./prepare-cache.mjs";

function fixture(t) {
  const directory = realpathSync(mkdtempSync(resolve(tmpdir(), "reference-cache-test-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cache = resolve(directory, "cache");
  const repository = resolve(directory, "repo");
  const source = resolve(cache, "source");
  const bridge = resolve(repository, "bridge");
  const overlay = resolve(source, "impl/golang/cmd/scaffold-reference");
  mkdirSync(resolve(source, "impl/golang/cmd/upstream"), { recursive: true, mode: 0o700 });
  mkdirSync(bridge, { recursive: true });
  writeFileSync(resolve(source, ".gitignore"), "ignored.go\n");
  writeFileSync(resolve(source, "impl/golang/go.mod"), "module fixture\n\ngo 1.27.1\n");
  writeFileSync(resolve(source, "impl/golang/go.sum"), "");
  writeFileSync(
    resolve(source, "impl/golang/cmd/upstream/main.go"),
    "package main\nfunc main() {}\n",
  );
  writeFileSync(resolve(bridge, "main.go"), "package main\nfunc main() {}\n");
  function run(program, args, cwd = source) {
    const result = spawnSync(program, args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  run("git", ["init", "--quiet"]);
  run("git", ["add", "."]);
  run("git", [
    "-c",
    "user.name=Reference test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const revision = run("git", ["rev-parse", "HEAD"]).trim();
  return { directory, cache, repository, source, bridge, overlay, run, revision };
}

test("cached overlay is exact after a source file is deleted; old bytes are retained", (t) => {
  const f = fixture(t);
  writeFileSync(resolve(f.bridge, "removed.go"), "package main\nvar oldBehavior = true\n");
  const first = synchronizeOverlay(f.cache, f.source, f.bridge);
  assert.equal(first.retainedOverlay, null);
  unlinkSync(resolve(f.bridge, "removed.go"));
  writeFileSync(resolve(f.overlay, "operator-note.txt"), "keep my notes");
  const second = synchronizeOverlay(f.cache, f.source, f.bridge);
  assert.equal(existsSync(resolve(f.overlay, "removed.go")), false);
  assert.deepEqual(treeManifest(f.overlay), treeManifest(f.bridge));
  assert.equal(
    readFileSync(resolve(second.retainedOverlay, "operator-note.txt"), "utf8"),
    "keep my notes",
  );
  assert.match(readFileSync(resolve(second.retainedOverlay, "removed.go"), "utf8"), /oldBehavior/);
  assert.equal(synchronizeOverlay(f.cache, f.source, f.bridge).retainedOverlay, null);
});

test("untracked and ignored upstream source are rejected without deleting either", (t) => {
  const f = fixture(t);
  synchronizeOverlay(f.cache, f.source, f.bridge);
  checkCheckout(f.source, f.run, f.revision);
  for (const name of ["injected.go", "ignored.go"]) {
    const path = resolve(f.source, "impl/golang", name);
    writeFileSync(path, "package injected");
    assert.throws(
      () => checkCheckout(f.source, f.run, f.revision),
      /Unexpected untracked upstream/,
    );
    assert.equal(readFileSync(path, "utf8"), "package injected");
    unlinkSync(path);
  }
});

test("tracked edits and a different upstream pin fail closed", (t) => {
  const f = fixture(t);
  assert.throws(
    () => checkCheckout(f.source, f.run, "0".repeat(40)),
    /Unexpected upstream revision/,
  );
  writeFileSync(resolve(f.source, "impl/golang/cmd/upstream/main.go"), "package changed");
  assert.throws(() => checkCheckout(f.source, f.run, f.revision), /Upstream source was modified/);
});

test("symlinks in input and existing overlay cannot escape the cache", (t) => {
  const f = fixture(t);
  const outside = resolve(f.directory, "operator-file");
  writeFileSync(outside, "preserve outside");
  symlinkSync(outside, resolve(f.bridge, "linked.go"));
  assert.throws(() => synchronizeOverlay(f.cache, f.source, f.bridge), /Symlinks are not allowed/);
  unlinkSync(resolve(f.bridge, "linked.go"));
  symlinkSync(f.bridge, f.overlay);
  assert.throws(() => synchronizeOverlay(f.cache, f.source, f.bridge), /real directory/);
  assert.equal(readFileSync(outside, "utf8"), "preserve outside");
});

test("cache must be external and real; concurrent preparation refuses an existing lock", (t) => {
  const f = fixture(t);
  assert.equal(openCache(f.cache, f.repository), f.cache);
  assert.throws(
    () => openCache(resolve(f.repository, "cache"), f.repository),
    /outside the repository/,
  );
  const alias = resolve(f.directory, "cache-link");
  symlinkSync(f.cache, alias);
  assert.throws(() => openCache(alias, f.repository), /must not be a symlink/);
  const unlock = lockCache(f.cache);
  assert.throws(() => lockCache(f.cache), /already has a lock/);
  unlock();
  lockCache(f.cache)();
});

test("atomic generated output refuses symlinks and leaves target intact", (t) => {
  const f = fixture(t);
  const outside = resolve(f.directory, "operator-file");
  writeFileSync(outside, "preserve outside");
  const output = resolve(f.cache, "build-provenance.json");
  symlinkSync(outside, output);
  assert.throws(() => writeAtomic(output, "new"), /non-regular build output/);
  assert.equal(readFileSync(outside, "utf8"), "preserve outside");
});

test("modified generated manifests are retained byte-for-byte before restoring the pin", (t) => {
  const f = fixture(t);
  const moduleRoot = resolve(f.source, "impl/golang");
  const edits = { "go.mod": "operator replace directive\n", "go.sum": "operator checksums\n" };
  for (const [name, bytes] of Object.entries(edits))
    writeFileSync(resolve(moduleRoot, name), bytes);
  checkCheckout(f.source, f.run, f.revision);
  const retained = restoreManifests(f.cache, f.source, f.run, f.revision);
  for (const [name, bytes] of Object.entries(edits)) {
    assert.equal(readFileSync(resolve(retained, name), "utf8"), bytes);
    assert.equal(
      readFileSync(resolve(moduleRoot, name), "utf8"),
      f.run("git", ["show", `${f.revision}:impl/golang/${name}`]),
    );
    writeFileSync(resolve(moduleRoot, name), bytes);
  }
  assert.equal(restoreManifests(f.cache, f.source, f.run, f.revision), retained);
  unlinkSync(resolve(moduleRoot, "go.mod"));
  checkCheckout(f.source, f.run, f.revision);
  restoreManifests(f.cache, f.source, f.run, f.revision);
  assert.match(readFileSync(resolve(moduleRoot, "go.mod"), "utf8"), /module fixture/);
});

test("failed build publication preserves the last binary and provenance", (t) => {
  const f = fixture(t);
  const binary = resolve(f.cache, "neuron-reference");
  const provenance = resolve(f.cache, "build-provenance.json");
  writeFileSync(binary, "last successful binary");
  writeFileSync(provenance, '{"previous":true}\n');
  assert.throws(
    () => publishBuild(f.cache, resolve(f.cache, "missing-stage"), binary, { next: true }),
    /ENOENT/,
  );
  assert.equal(readFileSync(binary, "utf8"), "last successful binary");
  assert.equal(readFileSync(provenance, "utf8"), '{"previous":true}\n');
  const stage = resolve(f.cache, "stage");
  writeFileSync(stage, "next successful binary");
  unlinkSync(provenance);
  symlinkSync(binary, provenance);
  assert.throws(() => publishBuild(f.cache, stage, binary, { next: true }), /regular file/);
  assert.equal(readFileSync(binary, "utf8"), "last successful binary");
  assert.equal(readFileSync(stage, "utf8"), "next successful binary");
  unlinkSync(provenance);
  publishBuild(f.cache, stage, binary, { next: true });
  assert.equal(readFileSync(binary, "utf8"), "next successful binary");
  assert.deepEqual(JSON.parse(readFileSync(provenance, "utf8")), { next: true });
});
