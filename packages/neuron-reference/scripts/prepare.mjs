#!/usr/bin/env node
// The upstream Go module has internal packages. Build our original bridge as an
// overlay in an exact upstream checkout; never copy that checkout into this repo.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkCheckout,
  lockCache,
  openCache,
  publishBuild,
  requireDirectory,
  restoreManifests,
  synchronizeOverlay,
} from "./prepare-cache.mjs";

const revision = "13ab01d70ac42531065094a52cd595ef7b6d3223";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = openCache(
  resolve(
    process.env.NEURON_REFERENCE_CACHE || resolve(homedir(), ".cache/neuron-reference", revision),
  ),
  resolve(root, "../.."),
);
const source = resolve(cache, "source");
const env = { ...process.env, GOTOOLCHAIN: "go1.27.1", GOWORK: "off", GOFLAGS: "" };
function run(program, args, cwd = cache) {
  const result = spawnSync(program, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0)
    throw new Error(`${program} ${args[0]} failed: ${result.stderr || result.error}`);
  return result.stdout;
}
const unlock = lockCache(cache);
try {
  if (!existsSync(resolve(source, ".git"))) {
    if (existsSync(source) && (!lstatSync(source).isDirectory() || readdirSync(source).length))
      throw new Error(
        "Reference source cache is not an empty directory; preserve it and choose a clean cache",
      );
    mkdirSync(source, { recursive: true, mode: 0o700 });
    run("git", ["init", "--quiet"], source);
    run(
      "git",
      ["remote", "add", "origin", "https://github.com/NeuronInnovations/neuron-specs.git"],
      source,
    );
    run("git", ["fetch", "--depth=1", "origin", revision], source);
    run("git", ["checkout", "--detach", "--quiet", revision], source);
  }
  checkCheckout(source, run, revision);
  const moduleRoot = resolve(source, "impl/golang");
  requireDirectory(moduleRoot);
  const { inputs, retainedOverlay } = synchronizeOverlay(cache, source, resolve(root, "bridge"));
  // Existing generated manifests may be stale or contain operator edits. Restore
  // the pinned bytes before applying the explicit dependency upgrades every time.
  const retainedManifests = restoreManifests(cache, source, run, revision);
  // Keep upstream protocol source unchanged while applying the pinned
  // transport/runtime dependency updates recorded in the build provenance.
  run("go", ["mod", "edit", "-go=1.27.1"], moduleRoot);
  run(
    "go",
    [
      "get",
      "github.com/hiero-ledger/hiero-sdk-go/v2@v2.85.1",
      "github.com/libp2p/go-libp2p@v0.50.0",
      "google.golang.org/grpc@v1.84.0",
      "golang.org/x/crypto@v0.57.0",
      "github.com/pion/dtls/v3@v3.1.4",
      "github.com/pion/stun/v3@v3.1.5",
    ],
    moduleRoot,
  );
  const binary = resolve(cache, "neuron-reference");
  if (existsSync(binary) && !lstatSync(binary).isFile())
    throw new Error("Reference binary output must be a regular file");
  const stagedBinary = resolve(cache, `.neuron-reference-${randomUUID()}`);
  try {
    run(
      "go",
      ["build", "-mod=readonly", "-trimpath", "-o", stagedBinary, "./cmd/scaffold-reference"],
      moduleRoot,
    );
    publishBuild(cache, stagedBinary, binary, {
      upstreamRevision: revision,
      toolchain: run("go", ["version"], moduleRoot).trim(),
      goModule: readFileSync(resolve(moduleRoot, "go.mod"), "utf8"),
      goSumSHA256: createHash("sha256")
        .update(readFileSync(resolve(moduleRoot, "go.sum")))
        .digest("hex"),
      overlay: inputs,
      retainedOverlay,
      retainedManifests,
      binary,
      binarySHA256: createHash("sha256").update(readFileSync(stagedBinary)).digest("hex"),
    });
  } finally {
    if (existsSync(stagedBinary)) rmSync(stagedBinary);
  }
  process.stdout.write(`${binary}\n`);
} finally {
  unlock();
}
