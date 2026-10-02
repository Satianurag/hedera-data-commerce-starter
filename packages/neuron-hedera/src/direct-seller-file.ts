import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { parseDirectSellerProfile, type DirectSellerProfile } from "./direct-seller.js";

export function loadDirectSellerProfile(env: Record<string, string | undefined>): DirectSellerProfile | null {
  const mode = env.NEURON_SELLER_DISCOVERY || "canonical";
  const path = env.NEURON_DIRECT_SELLER_PROFILE_FILE;
  if (mode === "canonical" && !path) return null;
  if (mode !== "direct" || !path || !isAbsolute(path) || env.HEDERA_NETWORK !== "testnet" ||
      (env.HEDERA_CHAIN_ID && env.HEDERA_CHAIN_ID !== "296")) {
    throw new Error("Direct seller discovery requires explicit testnet and a private profile file");
  }
  const parent = lstatSync(dirname(path));
  const info = lstatSync(path);
  const owned = (stat: typeof info) => !process.getuid || stat.uid === process.getuid();
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 || !owned(parent) ||
      !info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || !owned(info) || info.size > 16_384) {
    throw new Error("Direct seller profile and parent must be owner-only regular paths");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value: unknown;
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size > 16_384 ||
        !opened.isFile() || (opened.mode & 0o077) !== 0 || !owned(opened)) throw new Error("Direct seller profile changed while opening");
    const raw = readFileSync(fd);
    if (raw.length > 16_384) throw new Error("Direct seller profile exceeds size limit");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    value = JSON.parse(text);
    // This schema is flat and its validated values contain no JSON punctuation.
    // Count decoded field names as well as checking the parsed shape so duplicate
    // names cannot have different meanings in the Go and JavaScript readers.
    const names = [...text.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)]
      .map(match => JSON.parse(`"${match[1]}"`) as string);
    if (names.length !== 12 || new Set(names).size !== names.length) {
      throw new Error("Duplicate or missing direct seller profile field");
    }
  } finally { closeSync(fd); }
  const profile = parseDirectSellerProfile(value);
  if (profile.transport === "loopback") {
    const origin = new URL(env.NEURON_APP_ORIGIN ?? "");
    const gateway = new URL(env.NEURON_GATEWAY_WS_URL ?? "");
    const loopback = (url: URL) => ["localhost", "127.0.0.1"].includes(url.hostname) && !url.username &&
      !url.password && !url.search && !url.hash;
    if (env.NEURON_ENABLE_LOCAL_STREAM !== "true" || env.NEURON_ENABLE_REMOTE_STREAM === "true" ||
        !loopback(origin) || origin.protocol !== "http:" || origin.pathname !== "/" ||
        !loopback(gateway) || gateway.protocol !== "ws:" || !gateway.port || gateway.pathname !== "/stream") {
      throw new Error("Loopback seller transport requires an explicitly local browser and gateway");
    }
  }
  const bindings = { NEURON_SELLER_ACCOUNT_ID: profile.accountId,
    NEURON_SELLER_STDIN_TOPIC_ID: profile.stdinTopicId,
    NEURON_COMMERCE_SELLER_ACCOUNT_ID: profile.accountId,
    NEURON_COMMERCE_QUOTE_TOPIC_ID: profile.quoteTopicId, NEURON_COMMERCE_SERVICE_ID: profile.serviceId };
  for (const [name, expected] of Object.entries(bindings)) {
    if (env[name] !== undefined && env[name] !== expected) throw new Error(`Direct seller profile conflicts with ${name}`);
  }
  return profile;
}
