import assert from "node:assert/strict";
import test from "node:test";
import { isNpm10LockfileRewrite } from "../scaffold-lockfile.mjs";

// Self-contained so these regressions also run inside an npm@10 scaffold,
// whose project lockfile has already gone through the expected rewrite.
const canonical = {
  name: "example",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "example", devDependencies: { prettier: "3.9.9" } },
    "node_modules/native-gnu": {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/native-gnu/-/native-gnu-1.0.0.tgz",
      integrity: "sha512-fixture",
      optional: true,
      os: ["linux"],
      cpu: ["x64"],
      libc: ["glibc"],
    },
    "node_modules/native-musl": {
      version: "1.0.0",
      optional: true,
      os: ["linux"],
      cpu: ["arm64"],
      libc: ["musl"],
    },
  },
};
const source = Buffer.from(JSON.stringify(canonical));
const rewritten = structuredClone(canonical);
const libcPackages = Object.entries(rewritten.packages).filter(([, metadata]) => metadata.libc);
for (const [, metadata] of libcPackages) delete metadata.libc;
const encode = (value) => Buffer.from(JSON.stringify(value));

test("npm@10 may omit only optional Linux libc metadata", () => {
  assert.ok(libcPackages.length > 0);
  assert.equal(isNpm10LockfileRewrite(source, encode(rewritten), "10.9.9"), true);
  for (const version of ["11.19.0", "9.9.4", "", "v10.9.9"])
    assert.equal(isNpm10LockfileRewrite(source, encode(rewritten), version), false);
});

test("npm@10 rewrite still rejects graph, integrity, platform and classification changes", () => {
  const key = libcPackages[0][0];
  const mutations = {
    version: (lock) => (lock.packages[key].version = "0.0.0"),
    integrity: (lock) => (lock.packages[key].integrity = "sha512-changed"),
    resolved: (lock) => (lock.packages[key].resolved = "https://example.invalid/package.tgz"),
    cpu: (lock) => (lock.packages[key].cpu = ["changed"]),
    os: (lock) => (lock.packages[key].os = ["darwin"]),
    optional: (lock) => (lock.packages[key].optional = false),
    devOptional: (lock) => (lock.packages[key].devOptional = true),
    libc: (lock) => (lock.packages[key].libc = ["changed"]),
    edge: (lock) => (lock.packages[""].devDependencies.prettier = "0.0.0"),
    added: (lock) => (lock.packages["node_modules/unexpected"] = { version: "1.0.0" }),
    removed: (lock) => delete lock.packages[key],
    lockfileVersion: (lock) => (lock.lockfileVersion = 2),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const changed = structuredClone(rewritten);
    mutate(changed);
    assert.equal(isNpm10LockfileRewrite(source, encode(changed), "10.9.9"), false, name);
  }
});

test("missing, malformed and non-optional libc metadata never gets a blanket exemption", () => {
  assert.equal(isNpm10LockfileRewrite(source, Buffer.from("{"), "10.9.9"), false);
  assert.equal(isNpm10LockfileRewrite(source, undefined, "10.9.9"), false);
  assert.equal(isNpm10LockfileRewrite(source, source, "10.9.9"), false);
  const nonOptional = structuredClone(canonical);
  nonOptional.packages[libcPackages[0][0]].optional = false;
  const changed = structuredClone(nonOptional);
  for (const metadata of Object.values(changed.packages)) delete metadata.libc;
  assert.equal(isNpm10LockfileRewrite(encode(nonOptional), encode(changed), "10.9.9"), false);
});
