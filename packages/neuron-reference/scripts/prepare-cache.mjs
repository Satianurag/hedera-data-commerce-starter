import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

function inspect(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function requireDirectory(path, create = false) {
  let stat = inspect(path);
  if (!stat && create) {
    requireDirectory(dirname(path), true);
    mkdirSync(path, { mode: 0o700 });
    stat = lstatSync(path);
  }
  if (!stat?.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Expected a real directory: ${path}`);
  return path;
}

export function openCache(path, repository) {
  // Resolve ancestor aliases once (for example macOS /tmp), but never follow a
  // cache-directory symlink. Only this owner may modify the build cache.
  if (inspect(path)?.isSymbolicLink()) throw new Error("Reference cache must not be a symlink");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const cache = realpathSync(requireDirectory(path));
  const repo = realpathSync(repository);
  const within = relative(repo, cache);
  if (!within || (!within.startsWith(`..${sep}`) && within !== ".." && !within.startsWith(sep))) {
    throw new Error("Reference cache must be outside the repository");
  }
  const stat = lstatSync(cache);
  if (
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    stat.mode & 0o022
  ) {
    throw new Error("Reference cache must be owned by this user and not writable by other users");
  }
  return cache;
}

export function lockCache(cache) {
  const path = resolve(cache, ".prepare.lock");
  let fd;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "Reference preparation already has a lock; reconcile the prior process before removing its lock",
      );
    throw error;
  }
  writeFileSync(fd, `${process.pid}\n`);
  return () => {
    closeSync(fd);
    unlinkSync(path);
  };
}

export function treeManifest(directory) {
  requireDirectory(directory);
  const files = [];
  function walk(path, prefix) {
    for (const name of readdirSync(path).sort()) {
      const file = resolve(path, name);
      const stat = lstatSync(file);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (stat.isSymbolicLink())
        throw new Error(`Symlinks are not allowed in reference build inputs: ${rel}`);
      if (stat.isDirectory()) walk(file, rel);
      else if (stat.isFile())
        files.push({
          path: rel,
          sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
        });
      else throw new Error(`Non-regular reference build input: ${rel}`);
    }
  }
  walk(directory, "");
  return files;
}

export function checkCheckout(source, run, revision) {
  requireDirectory(source);
  requireDirectory(resolve(source, ".git"));
  if (run("git", ["rev-parse", "HEAD"], source).trim() !== revision)
    throw new Error("Unexpected upstream revision");
  const manifests = new Set(["impl/golang/go.mod", "impl/golang/go.sum"]);
  const changes = run("git", ["diff", "--name-only", "-z", "HEAD"], source)
    .split("\0")
    .filter(Boolean);
  if (changes.some((path) => !manifests.has(path)))
    throw new Error("Upstream source was modified; use a clean cache");
  // Unlike git diff, this includes untracked AND ignored files. No injected Go
  // source, vendor tree or go.work may silently join the pinned module.
  const extras = run("git", ["ls-files", "--others", "-z"], source).split("\0").filter(Boolean);
  if (extras.some((path) => !path.startsWith("impl/golang/cmd/scaffold-reference/"))) {
    throw new Error("Unexpected untracked upstream files; preserve them and use a clean cache");
  }
  for (const path of run("git", ["ls-files", "-z"], source).split("\0").filter(Boolean)) {
    const file = resolve(source, path);
    const stat = inspect(file);
    if ((!stat && !manifests.has(path)) || (stat && !stat.isFile()))
      throw new Error(`Upstream build input is not a regular file: ${path}`);
    for (let parent = dirname(file); parent !== source; parent = dirname(parent))
      requireDirectory(parent);
  }
}

export function restoreManifests(cache, source, run, revision) {
  const names = ["go.mod", "go.sum"];
  const moduleRoot = requireDirectory(resolve(source, "impl/golang"));
  const pinned = names.map((name) => ({
    name,
    bytes: run("git", ["show", `${revision}:impl/golang/${name}`], source),
  }));
  const previous = names.flatMap((name) => {
    const path = resolve(moduleRoot, name);
    const stat = inspect(path);
    if (!stat) return [];
    if (!stat.isFile()) throw new Error("Generated manifests must be regular files");
    return [{ name, bytes: readFileSync(path) }];
  });
  const changed = previous.some(
    (file) =>
      !file.bytes.equals(Buffer.from(pinned.find((entry) => entry.name === file.name).bytes)),
  );
  let retainedManifests = null;
  if (changed) {
    const hashes = previous.map((file) => ({
      path: file.name,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
    }));
    const digest = createHash("sha256").update(JSON.stringify(hashes)).digest("hex");
    const retained = requireDirectory(resolve(cache, "retained-manifests"), true);
    retainedManifests = resolve(retained, digest);
    if (inspect(retainedManifests)) {
      if (JSON.stringify(treeManifest(retainedManifests)) !== JSON.stringify(hashes))
        throw new Error("Retained manifest backup was modified; preserve it and use a clean cache");
    } else {
      const stage = mkdtempSync(resolve(cache, ".manifest-stage-"));
      try {
        for (const file of previous)
          writeFileSync(resolve(stage, file.name), file.bytes, { flag: "wx", mode: 0o600 });
        renameSync(stage, retainedManifests);
      } finally {
        if (existsSync(stage)) rmSync(stage, { recursive: true });
      }
    }
  }
  for (const file of pinned) writeAtomic(resolve(moduleRoot, file.name), file.bytes);
  return retainedManifests;
}

export function writeAtomic(path, data, mode = 0o600) {
  const prior = inspect(path);
  if (prior && !prior.isFile()) throw new Error(`Refusing non-regular build output: ${path}`);
  const temp = `${path}.prepare-${randomUUID()}`;
  writeFileSync(temp, data, { mode, flag: "wx" });
  try {
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function publishBuild(cache, stagedBinary, binary, provenance) {
  const path = resolve(cache, "build-provenance.json");
  const prior = inspect(path);
  if (prior && !prior.isFile()) throw new Error("Build provenance must be a regular file");
  const previousBytes = prior ? readFileSync(path) : null;
  writeAtomic(path, JSON.stringify(provenance, null, 2));
  try {
    // Publish the executable last: provenance failure must not replace a
    // successful binary. If publication fails, restore its previous metadata.
    renameSync(stagedBinary, binary);
  } catch (error) {
    if (previousBytes) writeAtomic(path, previousBytes);
    else unlinkSync(path);
    throw error;
  }
}

export function synchronizeOverlay(cache, source, bridge) {
  const inputs = treeManifest(bridge);
  const moduleRoot = requireDirectory(resolve(source, "impl/golang"));
  const commandRoot = requireDirectory(resolve(moduleRoot, "cmd"));
  const overlay = resolve(commandRoot, "scaffold-reference");
  const old = inspect(overlay);
  if (old && !old.isDirectory()) throw new Error("Generated overlay must be a real directory");
  const previous = old ? treeManifest(overlay) : undefined;
  if (previous && JSON.stringify(previous) === JSON.stringify(inputs))
    return { inputs, retainedOverlay: null };
  const stage = mkdtempSync(resolve(cache, ".overlay-stage-"));
  let retainedOverlay = null;
  try {
    for (const input of inputs) {
      const target = resolve(stage, input.path);
      requireDirectory(dirname(target), true);
      writeFileSync(target, readFileSync(resolve(bridge, input.path)), { flag: "wx", mode: 0o600 });
    }
    if (JSON.stringify(treeManifest(stage)) !== JSON.stringify(inputs))
      throw new Error("Bridge inputs changed during preparation; rerun from stable source");
    if (old) {
      const retained = requireDirectory(resolve(cache, "retained-overlays"), true);
      retainedOverlay = resolve(retained, randomUUID());
      // Preserve stale/generated and unknown operator files instead of deleting
      // anything in an existing cache. Only the exact current overlay is built.
      renameSync(overlay, retainedOverlay);
    }
    renameSync(stage, overlay);
  } finally {
    // This unique staging directory was created by this invocation alone.
    if (existsSync(stage)) rmSync(stage, { recursive: true });
  }
  return { inputs, retainedOverlay };
}
