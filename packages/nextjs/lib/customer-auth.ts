import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, lstatSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import Database from "better-sqlite3";
import { getAddress, verifyMessage } from "ethers";
import { networkConfigFromEnv } from "@neuron/hedera";

const challengeLifetime = 5 * 60;
const sessionLifetime = 60 * 60;
const hex32 = /^[0-9a-f]{32}$/;
const hex64 = /^[0-9a-f]{64}$/;
const signaturePattern = /^0x[0-9a-fA-F]{130}$/;

export type CustomerSession = Readonly<{ sessionId: string; ownerAddress: string; expiresAt: number }>;
export class InvalidCustomerChallenge extends Error {}
export class InvalidCustomerRequest extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function databasePath(): string {
  const path = process.env.NEURON_CUSTOMER_DB_FILE;
  if (!path || !isAbsolute(path)) throw new Error("Customer session database requires an absolute path");
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 ||
      (process.getuid && parent.uid !== process.getuid())) {
    throw new Error("Customer session database directory must be owner-only");
  }
  try {
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0 ||
      (process.getuid && file.uid !== process.getuid())) {
    throw new Error("Customer session database must be an owner-only regular file");
  }
  return path;
}

function withDatabase<T>(work: (db: Database.Database) => T): T {
  const db = new Database(databasePath(), { fileMustExist: true, timeout: 5000 });
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    db.exec(`CREATE TABLE IF NOT EXISTS customer_challenges (
      id TEXT PRIMARY KEY, owner_address TEXT NOT NULL, message TEXT NOT NULL,
      expires_at INTEGER NOT NULL, consumed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS customer_sessions (
      token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE,
      owner_address TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
    );`);
    return work(db);
  } finally {
    db.close();
  }
}

export function customerAuthOrigin(): URL | null {
  if (process.env.NEURON_ENABLE_CUSTOMER_AUTH !== "true" || process.env.HEDERA_NETWORK !== "testnet") return null;
  const value = process.env.NEURON_APP_ORIGIN;
  if (!value) throw new Error("Customer auth requires NEURON_APP_ORIGIN");
  const origin = new URL(value);
  const loopback = origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname) && Boolean(origin.port);
  if ((!loopback && origin.protocol !== "https:") || origin.origin !== value || origin.pathname !== "/" ||
      origin.search || origin.hash || origin.username || origin.password) {
    throw new Error("Customer auth origin must be an exact HTTPS or loopback HTTP origin");
  }
  return origin;
}

export function sameOrigin(request: Request, origin: URL): boolean {
  return request.headers.get("origin") === origin.origin && request.headers.get("host") === origin.host;
}

export async function readObject(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new InvalidCustomerRequest("Request body is required");
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 2048) {
      await reader.cancel();
      throw new InvalidCustomerRequest("Request body is too large", 413);
    }
    parts.push(value);
  }
  let value: unknown;
  try {
    const body = new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(parts));
    value = JSON.parse(body);
  } catch {
    throw new InvalidCustomerRequest("Request body must be valid UTF-8 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidCustomerRequest("Request body must be an object");
  return value as Record<string, unknown>;
}

export function issueCustomerChallenge(origin: URL, claimedAddress: string): Readonly<{
  challengeId: string; message: string; chainId: number;
}> {
  const config = networkConfigFromEnv(process.env);
  if (config.network !== "testnet") throw new Error("Customer auth is testnet-only");
  const ownerAddress = getAddress(claimedAddress);
  const now = Math.floor(Date.now() / 1000);
  const challengeId = randomBytes(16).toString("hex");
  const nonce = randomBytes(16).toString("hex");
  const message = ["Neuron Customer App sign-in", `Origin: ${origin.origin}`, `Wallet: ${ownerAddress}`, "Network: Hedera testnet",
    `EVM Chain ID: ${config.chainId}`, `Nonce: ${nonce}`, `Issued At: ${new Date(now * 1000).toISOString()}`,
    `Expires At: ${new Date((now + challengeLifetime) * 1000).toISOString()}`,
    "This signature authenticates a browser session. It does not authorize a payment."].join("\n");
  withDatabase(db => db.transaction(() => {
    db.prepare("DELETE FROM customer_challenges WHERE expires_at <= ? OR consumed_at IS NOT NULL").run(now);
    const count = db.prepare("SELECT COUNT(*) AS n FROM customer_challenges").get() as { n: number };
    if (count.n >= 1024) throw new Error("Too many outstanding sign-in challenges");
    db.prepare("INSERT INTO customer_challenges (id, owner_address, message, expires_at) VALUES (?, ?, ?, ?)")
      .run(challengeId, ownerAddress, message, now + challengeLifetime);
  })());
  return { challengeId, message, chainId: config.chainId };
}

export function verifyCustomerChallenge(challengeId: string, signature: string): Readonly<{
  session: CustomerSession; token: string;
}> {
  if (!hex32.test(challengeId) || !signaturePattern.test(signature)) throw new InvalidCustomerChallenge("Invalid challenge or signature");
  const now = Math.floor(Date.now() / 1000);
  return withDatabase(db => {
    const challenge = db.prepare("SELECT owner_address, message, expires_at, consumed_at FROM customer_challenges WHERE id = ?")
      .get(challengeId) as { owner_address: string; message: string; expires_at: number; consumed_at: number | null } | undefined;
    if (!challenge || challenge.consumed_at !== null || challenge.expires_at <= now) {
      throw new InvalidCustomerChallenge("Challenge is missing, expired or already used");
    }
    let ownerAddress: string;
    try {
      ownerAddress = getAddress(verifyMessage(challenge.message, signature));
    } catch {
      throw new InvalidCustomerChallenge("Invalid wallet signature");
    }
    if (ownerAddress !== challenge.owner_address) throw new InvalidCustomerChallenge("Signature does not match the requested wallet");
    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const sessionId = randomBytes(16).toString("hex");
    const session = { sessionId, ownerAddress, expiresAt: now + sessionLifetime };
    db.transaction(() => {
      const consumed = db.prepare("UPDATE customer_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?")
        .run(now, challengeId, now);
      if (consumed.changes !== 1) throw new InvalidCustomerChallenge("Challenge was already used");
      db.prepare("DELETE FROM customer_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").run(now);
      const count = db.prepare("SELECT COUNT(*) AS n FROM customer_sessions").get() as { n: number };
      if (count.n >= 10000) throw new Error("Too many active customer sessions");
      db.prepare("INSERT INTO customer_sessions (token_hash, session_id, owner_address, expires_at) VALUES (?, ?, ?, ?)")
        .run(tokenHash, sessionId, ownerAddress, session.expiresAt);
    })();
    return { session, token };
  });
}

export function getCustomerSession(token: string | undefined): CustomerSession | null {
  if (!token || !hex64.test(token)) return null;
  const hash = createHash("sha256").update(token).digest("hex");
  const now = Math.floor(Date.now() / 1000);
  return withDatabase(db => {
    const row = db.prepare("SELECT session_id, owner_address, expires_at FROM customer_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?")
      .get(hash, now) as { session_id: string; owner_address: string; expires_at: number } | undefined;
    return row ? { sessionId: row.session_id, ownerAddress: row.owner_address, expiresAt: row.expires_at } : null;
  });
}

export function revokeCustomerSession(token: string | undefined): void {
  if (!token || !hex64.test(token)) return;
  const hash = createHash("sha256").update(token).digest("hex");
  withDatabase(db => db.prepare("UPDATE customer_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
    .run(Math.floor(Date.now() / 1000), hash));
}

export function customerCookieName(origin: URL): string {
  return origin.protocol === "https:" ? "__Host-neuron_session" : "neuron_session_dev";
}

export function customerCookie(origin: URL, token: string, maxAge = sessionLifetime): string {
  return `${customerCookieName(origin)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}` +
    (origin.protocol === "https:" ? "; Secure" : "");
}

export function customerToken(request: Request, origin: URL): string | undefined {
  const cookie = request.headers.get("cookie") ?? "";
  const entry = cookie.split(";").map(part => part.trim()).find(part => part.startsWith(`${customerCookieName(origin)}=`));
  return entry?.slice(customerCookieName(origin).length + 1);
}
