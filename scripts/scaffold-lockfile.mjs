import { isDeepStrictEqual } from "node:util";

// npm@10's lockfile writer omits libc (npm@11 preserves it). The published
// scaffold CLI invokes installation, so this one metadata rewrite is expected.
// Keep every dependency, integrity, edge, flag and other platform selector exact.
export function isNpm10LockfileRewrite(source, generated, npmVersion) {
  if (!npmVersion.startsWith("10.")) return false;
  try {
    const expected = JSON.parse(source.toString("utf8"));
    const actual = JSON.parse(generated.toString("utf8"));
    if (expected.lockfileVersion !== 3 || !expected.packages) return false;
    let removed = 0;
    for (const metadata of Object.values(expected.packages)) {
      if (
        metadata.optional === true &&
        isDeepStrictEqual(metadata.os, ["linux"]) &&
        (isDeepStrictEqual(metadata.libc, ["glibc"]) || isDeepStrictEqual(metadata.libc, ["musl"]))
      ) {
        delete metadata.libc;
        removed++;
      }
    }
    return removed > 0 && isDeepStrictEqual(expected, actual);
  } catch {
    return false;
  }
}
