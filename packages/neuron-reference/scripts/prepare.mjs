#!/usr/bin/env node
// The upstream Go module has internal packages. Build our original bridge as an
// overlay in an exact upstream checkout; never copy that checkout into this repo.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const revision = "13ab01d70ac42531065094a52cd595ef7b6d3223";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = resolve(process.env.NEURON_REFERENCE_CACHE || resolve(homedir(), ".cache/neuron-reference", revision));
const source = resolve(cache, "source");
const env = { ...process.env, GOTOOLCHAIN: "go1.27.1" };
function run(program, args, cwd = cache) {
  const result = spawnSync(program, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`${program} ${args[0]} failed: ${result.stderr || result.error}`);
  return result.stdout.trim();
}
mkdirSync(cache, { recursive: true, mode: 0o700 });
if (!existsSync(resolve(source, ".git"))) {
  mkdirSync(source, { recursive: true, mode: 0o700 });
  run("git", ["init", "--quiet"], source);
  run("git", ["remote", "add", "origin", "https://github.com/NeuronInnovations/neuron-specs.git"], source);
  run("git", ["fetch", "--depth=1", "origin", revision], source);
  run("git", ["checkout", "--detach", "--quiet", revision], source);
}
if (run("git", ["rev-parse", "HEAD"], source) !== revision) throw new Error("Unexpected upstream revision");
const moduleRoot = resolve(source, "impl/golang");
// Only our generated overlay and dependency manifests may differ from the pin.
const changes = run("git", ["diff", "--name-only", "HEAD"], source).split("\n").filter(Boolean);
if (changes.some(path => !["impl/golang/go.mod", "impl/golang/go.sum"].includes(path))) throw new Error("Upstream source was modified; use a clean cache");
const overlay = resolve(moduleRoot, "cmd/scaffold-reference");
mkdirSync(overlay, { recursive: true });
cpSync(resolve(root, "bridge"), overlay, { recursive: true });
// Security patches already used by the candidate. Upstream protocol source is
// unchanged; these selected transport/runtime dependencies are recorded below.
run("go", ["mod", "edit", "-go=1.27.1"], moduleRoot);
run("go", ["get", "github.com/hiero-ledger/hiero-sdk-go/v2@v2.85.1", "github.com/libp2p/go-libp2p@v0.50.0", "google.golang.org/grpc@v1.84.0", "golang.org/x/crypto@v0.57.0", "github.com/pion/dtls/v3@v3.1.4", "github.com/pion/stun/v3@v3.1.5"], moduleRoot);
const binary = resolve(cache, "neuron-reference");
run("go", ["build", "-trimpath", "-o", binary, "./cmd/scaffold-reference"], moduleRoot);
writeFileSync(resolve(cache, "build-provenance.json"), JSON.stringify({ upstreamRevision: revision, toolchain: run("go", ["version"], moduleRoot), goModule: readFileSync(resolve(moduleRoot, "go.mod"), "utf8"), binary }, null, 2), { mode: 0o600 });
process.stdout.write(`${binary}\n`);
