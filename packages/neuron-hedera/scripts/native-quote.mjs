import { loadDirectSellerProfile } from "../dist/direct-seller-file.js";
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SigningKey, Wallet, getAddress, keccak256 } from "ethers";
import { checkDirectSellerBinding, getMirrorContract, inspectSignedTopicEnvelope,
  networkConfigFromEnv } from "../dist/index.js";

const id = /^0\.0\.[1-9]\d*$/;

function boundedInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}

function tinybar(value, name) {
  if (typeof value !== "string" || !/^[1-9]\d{0,8}$/.test(value) || BigInt(value) > 100_000_000n) {
    throw new Error(`${name} must be a positive tinybar string, at most 1 HBAR`);
  }
  return BigInt(value);
}

/** Prepare actual seller-signed terms. This does not assert HCS consensus or send a transaction. */
export function createNativeSellerQuote({ descriptor, profile, privateKey, amountTinybar,
  durationSeconds, quoteLifetimeSeconds, refundDelaySeconds, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const wallet = new Wallet(privateKey);
  const key = SigningKey.computePublicKey(wallet.privateKey, true).slice(2);
  if (!descriptor || descriptor.network !== "testnet" || descriptor.chainId !== 296 ||
      descriptor.sellerAccount !== profile.accountId || descriptor.quoteTopic !== profile.quoteTopicId ||
      descriptor.serviceId !== "1" || descriptor.serviceId !== profile.serviceId || key !== profile.publicKey ||
      !id.test(descriptor.escrowContractId) || !/^[0-9a-f]{32}$/.test(descriptor.sessionId)) {
    throw new Error("Descriptor and direct seller identity do not match");
  }
  const buyer = getAddress(descriptor.buyerAddress);
  const escrow = getAddress(descriptor.escrowAddress);
  if (buyer !== descriptor.buyerAddress || escrow !== descriptor.escrowAddress || buyer === wallet.address ||
      /^0x0{40}$/.test(buyer) || /^0x0{40}$/.test(escrow)) throw new Error("Invalid buyer or escrow address");
  boundedInteger(nowSeconds, 1, Number.MAX_SAFE_INTEGER - 86400, "clock");
  boundedInteger(durationSeconds, 1, 120, "delivery duration");
  // Funding needs >120 seconds remaining; approval needs its own >120-second
  // window after delivery. Reserve additional time for HCS and wallet prompts.
  boundedInteger(quoteLifetimeSeconds, 300, 3600, "quote lifetime");
  boundedInteger(refundDelaySeconds, quoteLifetimeSeconds + durationSeconds + 180, 86400, "refund delay");
  if (!Number.isSafeInteger(descriptor.sessionExpiresAt) || descriptor.sessionExpiresAt <= nowSeconds + quoteLifetimeSeconds) {
    throw new Error("The customer session must remain valid throughout the quote lifetime");
  }
  const amount = tinybar(amountTinybar, "Amount");
  if (amount > tinybar(descriptor.maxSpendTinybar, "Buyer cap")) throw new Error("Amount exceeds the buyer cap");
  const terms = {
    type: "neuronCustomerQuote", version: "1", network: "testnet", chainId: "296",
    sellerAccountId: profile.accountId, sellerAddress: wallet.address, buyerAddress: buyer,
    serviceId: "1", sessionId: descriptor.sessionId, asset: "HBAR", amountTinybar,
    maxAmountTinybar: amountTinybar, durationSeconds: String(durationSeconds), issuedAt: String(nowSeconds),
    expiresAt: String(nowSeconds + quoteLifetimeSeconds), refundAfter: String(nowSeconds + refundDelaySeconds),
    escrowContractId: descriptor.escrowContractId, escrowAddress: escrow, nonce: randomBytes(32).toString("hex"),
  };
  const payload = Buffer.from(JSON.stringify(terms));
  const timestamp = BigInt(nowSeconds) * 1_000_000_000n;
  const sequence = BigInt(`0x${randomBytes(8).toString("hex")}`) || 1n;
  const preimage = Buffer.alloc(16 + payload.length);
  preimage.writeBigUInt64BE(timestamp);
  preimage.writeBigUInt64BE(sequence, 8);
  payload.copy(preimage, 16);
  const signature = wallet.signingKey.sign(keccak256(preimage));
  const compact = Buffer.concat([Buffer.from(signature.r.slice(2), "hex"), Buffer.from(signature.s.slice(2), "hex"),
    Buffer.from([signature.yParity])]);
  const envelope = JSON.stringify({ senderAddress: wallet.address, signature: compact.toString("base64"),
    timestamp: String(timestamp), sequenceNumber: String(sequence), payload: payload.toString("base64") });
  if (inspectSignedTopicEnvelope(Buffer.from(envelope))?.compressedPublicKey !== key) {
    throw new Error("Local signature verification failed");
  }
  return { terms, termsHash: keccak256(payload), envelope };
}

export function readPrivateFile(path, maxBytes = 16_384) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Private file path must be absolute");
  const parent = lstatSync(dirname(path));
  const file = lstatSync(path);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 ||
      !file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0 || file.size > maxBytes ||
      (process.getuid && (file.uid !== process.getuid() || parent.uid !== process.getuid()))) {
    throw new Error("Private inputs require owner-controlled files and directories");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== file.ino || opened.dev !== file.dev || !opened.isFile() || (opened.mode & 0o077) !== 0 ||
        (process.getuid && opened.uid !== process.getuid())) throw new Error("Private file changed during open");
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maxBytes) throw new Error("Private input exceeds size bound");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally { closeSync(fd); }
}

/** JSON.parse alone silently accepts a second value for the same configuration field. */
export function parseUniqueJSON(text) {
  const value = JSON.parse(text);
  let offset = 0;
  const whitespace = () => { while (/\s/.test(text[offset] ?? "") && offset < text.length) offset++; };
  const string = () => {
    const start = offset++;
    while (offset < text.length) {
      if (text[offset++] === "\\") offset++;
      else if (text[offset - 1] === '"') return JSON.parse(text.slice(start, offset));
    }
    throw new Error("Invalid JSON string");
  };
  const scan = depth => {
    if (depth > 8) throw new Error("Configuration is too deeply nested");
    whitespace();
    if (text[offset] === "{") {
      offset++; whitespace();
      const seen = new Set();
      while (text[offset] !== "}") {
        const key = string();
        if (seen.has(key)) throw new Error(`Duplicate JSON field: ${key}`);
        seen.add(key); whitespace(); offset++; scan(depth + 1); whitespace();
        if (text[offset] !== ",") break;
        offset++; whitespace();
      }
      offset++;
    } else if (text[offset] === "[") {
      offset++; whitespace();
      while (text[offset] !== "]") { scan(depth + 1); whitespace(); if (text[offset] !== ",") break; offset++; }
      offset++;
    } else if (text[offset] === '"') string();
    else while (offset < text.length && !/[\s,}\]]/.test(text[offset])) offset++;
  };
  scan(0);
  return value;
}

export async function main() {
  const config = parseUniqueJSON(readPrivateFile(process.env.NEURON_NATIVE_QUOTE_CONFIG_FILE));
  const fields = ["descriptorFile", "sellerKeyFile", "amountTinybar", "durationSeconds", "quoteLifetimeSeconds",
    "refundDelaySeconds", "outputDirectory"];
  if (!config || typeof config !== "object" || Object.keys(config).sort().join() !== fields.sort().join()) {
    throw new Error("Quote configuration has missing or unsupported fields");
  }
  const profile = loadDirectSellerProfile(process.env);
  if (!profile) throw new Error("Quote preparation requires explicit direct seller discovery");
  const network = networkConfigFromEnv(process.env);
  await checkDirectSellerBinding(network, profile);
  const input = parseUniqueJSON(readPrivateFile(config.descriptorFile));
  const descriptor = input.seller ?? input;
  const privateKey = readPrivateFile(config.sellerKeyFile, 256).trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("Seller signing key must be 32 hex bytes");
  const prepared = createNativeSellerQuote({ ...config, descriptor, profile, privateKey: `0x${privateKey}` });
  const contract = await getMirrorContract(network, descriptor.escrowContractId);
  if (getAddress(contract.evm_address) !== descriptor.escrowAddress) throw new Error("Escrow address does not match Mirror");
  const output = config.outputDirectory;
  if (typeof output !== "string" || !isAbsolute(output)) throw new Error("Output directory must be absolute");
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const relativePath = relative(root, output);
  if (!relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(relativePath)) {
    throw new Error("Write quote artifacts outside the checkout");
  }
  const parent = lstatSync(dirname(output));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 ||
      (process.getuid && parent.uid !== process.getuid())) throw new Error("Output parent must be owner-only");
  mkdirSync(output, { mode: 0o700 }); // Existing artifacts must never be silently replaced.
  writeFileSync(resolve(output, "envelope.json"), prepared.envelope, { mode: 0o600, flag: "wx" });
  writeFileSync(resolve(output, "terms.json"), JSON.stringify(prepared.terms, null, 2), { mode: 0o600, flag: "wx" });
  writeFileSync(resolve(output, "prepared.json"), JSON.stringify({ state: "prepared-not-submitted", network: "testnet",
    sellerAccountId: profile.accountId, quoteTopicId: profile.quoteTopicId, termsHash: prepared.termsHash,
    amountTinybar: prepared.terms.amountTinybar, expiresAt: prepared.terms.expiresAt }, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ state: "prepared-not-submitted", outputDirectory: output, termsHash: prepared.termsHash }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
