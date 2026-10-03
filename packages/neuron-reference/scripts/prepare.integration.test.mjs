// Explicit integration check: fetches the public pinned source and builds/tests
// with Go. It performs no Hedera requests, signing, or funded transactions.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { treeManifest } from "./prepare-cache.mjs";

test(
  "real preparation removes deleted overlay code, resets generated manifests and refuses injected upstream code",
  { timeout: 300_000 },
  (t) => {
    const temporary = realpathSync(
      mkdtempSync(resolve(tmpdir(), "reference-prepare-integration-")),
    );
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const original = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const fixture = resolve(temporary, "fixture/packages/neuron-reference");
    mkdirSync(fixture, { recursive: true });
    cpSync(resolve(original, "scripts"), resolve(fixture, "scripts"), { recursive: true });
    cpSync(resolve(original, "bridge"), resolve(fixture, "bridge"), { recursive: true });
    const cache = resolve(temporary, "cache");
    const source = resolve(cache, "source");
    const moduleRoot = resolve(source, "impl/golang");
    const overlay = resolve(moduleRoot, "cmd/scaffold-reference");
    const env = {
      ...process.env,
      NEURON_REFERENCE_CACHE: cache,
      GOTOOLCHAIN: "go1.27.1",
      GOWORK: "off",
      GOFLAGS: "",
    };
    function prepare() {
      return spawnSync(process.execPath, [resolve(fixture, "scripts/prepare.mjs")], {
        env,
        encoding: "utf8",
        timeout: 180_000,
      });
    }
    const deletedInput = resolve(fixture, "bridge/obsolete_build_input.go");
    writeFileSync(deletedInput, "package main\nvar obsoleteBuildInput = true\n");
    const first = prepare();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(existsSync(resolve(overlay, "obsolete_build_input.go")), true);
    unlinkSync(deletedInput);
    // The old merge-copy implementation compiled this stale source and failed.
    writeFileSync(
      resolve(overlay, "zz_stale.go"),
      "package main\nvar stale = undefinedStaleBuildSymbol\n",
    );
    writeFileSync(
      resolve(moduleRoot, "go.mod"),
      "this stale generated manifest is not a Go module\n",
    );
    writeFileSync(resolve(moduleRoot, "go.sum"), "stale generated checksums\n");
    const second = prepare();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(existsSync(resolve(overlay, "obsolete_build_input.go")), false);
    assert.equal(existsSync(resolve(overlay, "zz_stale.go")), false);
    assert.deepEqual(treeManifest(overlay), treeManifest(resolve(fixture, "bridge")));
    const provenance = JSON.parse(readFileSync(resolve(cache, "build-provenance.json"), "utf8"));
    assert.equal(
      readFileSync(resolve(provenance.retainedManifests, "go.mod"), "utf8"),
      "this stale generated manifest is not a Go module\n",
    );
    assert.equal(
      readFileSync(resolve(provenance.retainedManifests, "go.sum"), "utf8"),
      "stale generated checksums\n",
    );
    assert.equal(provenance.upstreamRevision, "13ab01d70ac42531065094a52cd595ef7b6d3223");
    assert.deepEqual(provenance.overlay, treeManifest(overlay));
    assert.match(
      readFileSync(resolve(provenance.retainedOverlay, "zz_stale.go"), "utf8"),
      /undefinedStaleBuildSymbol/,
    );
    assert.match(readFileSync(resolve(moduleRoot, "go.mod"), "utf8"), /go 1\.27\.1/);
    const priorBinary = readFileSync(resolve(cache, "neuron-reference"));
    const injected = resolve(moduleRoot, "unexpected.go");
    writeFileSync(injected, "package injected\n");
    const rejected = prepare();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Unexpected untracked upstream files/);
    assert.equal(readFileSync(injected, "utf8"), "package injected\n");
    assert.deepEqual(readFileSync(resolve(cache, "neuron-reference")), priorBinary);
    unlinkSync(injected);
    for (const args of [
      ["test", "-race", "-count=1", "./cmd/scaffold-reference"],
      ["vet", "./cmd/scaffold-reference"],
    ]) {
      const result = spawnSync("go", args, {
        cwd: moduleRoot,
        env,
        encoding: "utf8",
        timeout: 120_000,
      });
      assert.equal(result.status, 0, result.stderr);
      t.diagnostic(`${args.join(" ")}: ${result.stdout.trim() || "passed"}`);
    }
  },
);
