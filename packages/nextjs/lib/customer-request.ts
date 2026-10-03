import { loadDirectSellerProfile } from "@neuron/hedera/direct-seller-file";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import {
  assertSellerUDPAddress,
  checkLegacyDeviceBinding,
  checkDirectSellerBinding,
  getMirrorAccount,
  getMirrorTopic,
  listLegacyDevices,
  networkConfigFromEnv,
} from "@neuron/hedera";
import { getCustomerSession, withCustomerDatabase, type CustomerSession } from "./customer-auth";
import { gatewayServerEndpoint } from "./gateway-endpoint";

const hederaId = /^0\.0\.[1-9]\d*$/;
const transactionIdPattern = /^0\.0\.[1-9]\d*@\d+\.\d{9}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const outputLimit = 16 * 1024;

export type CustomerRequestRecord = Readonly<{
  id: string;
  state: "reserved" | "submitting" | "uncertain" | "confirmed";
  sellerAccount: string;
  transactionId: string | null;
  payloadSha256: string | null;
  topicSequence: number | null;
}>;

export class CustomerRequestConflict extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type RequestConfig = Readonly<{
  seller: string;
  sellerTopic: string;
  buyer: string;
  buyerTopic: string;
  shared: string;
  operator: string;
  buyerKeyFile: string;
  operatorKeyFile: string;
  udpAddress: string;
  requestBinary: string;
  submitBinary: string;
  maxFee: string;
}>;

function ownerExecutable(value: string | undefined, label: string): string {
  if (!value || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  const parent = lstatSync(dirname(value));
  const file = lstatSync(value);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o077) !== 0 ||
    (process.getuid && parent.uid !== process.getuid()) ||
    !file.isFile() ||
    file.isSymbolicLink() ||
    (process.getuid && file.uid !== process.getuid()) ||
    (file.mode & 0o111) === 0 ||
    (file.mode & 0o022) !== 0
  ) {
    throw new Error(`${label} must be an owner-controlled executable`);
  }
  return value;
}

export function customerRequestEnabled(origin: URL | null): boolean {
  const localPilot =
    origin?.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname);
  const publicPilot =
    origin?.protocol === "https:" &&
    process.env.NEURON_ENABLE_PUBLIC_CUSTOMER_REQUEST === "true" &&
    process.env.NEURON_ENABLE_REMOTE_STREAM === "true";
  return (
    process.env.NEURON_ENABLE_CUSTOMER_REQUEST === "true" &&
    process.env.NEURON_ENABLE_CUSTOMER_AUTH === "true" &&
    process.env.HEDERA_NETWORK === "testnet" &&
    (process.env.NEURON_ENABLE_LOCAL_STREAM === "true" ||
      process.env.NEURON_ENABLE_REMOTE_STREAM === "true") &&
    Boolean(localPilot || publicPilot)
  );
}

function requestConfig(): RequestConfig {
  const env = process.env;
  const seller = env.NEURON_SELLER_ACCOUNT_ID ?? "";
  const sellerTopic = env.NEURON_SELLER_STDIN_TOPIC_ID ?? "";
  const buyer = env.HEDERA_BUYER_ACCOUNT_ID ?? "";
  const buyerTopic = env.HEDERA_BUYER_STDIN_TOPIC_ID ?? "";
  const shared = env.HEDERA_SHARED_ACCOUNT_ID ?? "";
  const operator = env.HEDERA_OPERATOR_ACCOUNT_ID ?? "";
  const ids = [seller, sellerTopic, buyer, buyerTopic, shared, operator];
  if (ids.some((id) => !hederaId.test(id)))
    throw new Error("Customer request account or topic configuration is invalid");
  const maxFee = env.HEDERA_MAX_FEE_TINYBAR ?? "";
  if (!/^[1-9]\d{0,8}$/.test(maxFee) || Number(maxFee) > 100_000_000) {
    throw new Error("Customer request fee cap must be positive and at most 1 HBAR");
  }
  if (env.NEURON_APP_ORIGIN?.startsWith("https://")) {
    const limit = env.NEURON_PUBLIC_REQUEST_LIMIT ?? "";
    if (!/^[1-9]\d?$|^100$/.test(limit)) {
      throw new Error("Public testnet request limit must be between 1 and 100");
    }
  }
  const buyerKeyFile = env.HEDERA_BUYER_KEY_FILE ?? "";
  const operatorKeyFile = env.HEDERA_OPERATOR_KEY_FILE ?? "";
  if (!isAbsolute(buyerKeyFile) || !isAbsolute(operatorKeyFile))
    throw new Error("Customer request keys require absolute paths");
  const udpAddress = env.NEURON_PUBLIC_UDP_MULTIADDR ?? "";
  assertSellerUDPAddress(udpAddress, loadDirectSellerProfile(env)?.transport ?? "public");
  return {
    seller,
    sellerTopic,
    buyer,
    buyerTopic,
    shared,
    operator,
    buyerKeyFile,
    operatorKeyFile,
    udpAddress,
    requestBinary: ownerExecutable(env.NEURON_LEGACY_REQUEST_BIN, "Legacy request binary"),
    submitBinary: ownerExecutable(env.NEURON_HCS_SUBMIT_BIN, "HCS submit binary"),
    maxFee,
  };
}

/** Gate a newly advertised testnet request path on current Mirror metadata. */
export async function preflightCustomerRequestDescriptor(): Promise<void> {
  const config = requestConfig();
  const network = networkConfigFromEnv(process.env);
  if (network.network !== "testnet" || network.chainId !== 296) {
    throw new Error("Customer requests require Hedera testnet chain 296");
  }
  const direct = loadDirectSellerProfile(process.env);
  if (direct) await checkDirectSellerBinding(network, direct);
  const [, , , , sellerTopic, buyerTopic] = await Promise.all([
    getMirrorAccount(network, config.seller),
    getMirrorAccount(network, config.buyer),
    getMirrorAccount(network, config.shared),
    getMirrorAccount(network, config.operator),
    getMirrorTopic(network, config.sellerTopic),
    getMirrorTopic(network, config.buyerTopic),
  ]);
  if (sellerTopic.submit_key !== null || buyerTopic.submit_key !== null) {
    throw new Error("Customer request and reply topics must be open on testnet");
  }
}

async function gatewayMatchesCustomer(
  sellerAccount: string,
  session: CustomerSession,
): Promise<boolean> {
  const configured = process.env.NEURON_GATEWAY_WS_URL;
  if (!configured) return false;
  let url: URL;
  try {
    url = new URL(configured);
    const local =
      process.env.NEURON_ENABLE_LOCAL_STREAM === "true" &&
      url.protocol === "ws:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
      Boolean(url.port);
    const remote =
      process.env.NEURON_ENABLE_REMOTE_STREAM === "true" &&
      url.protocol === "wss:" &&
      !url.port &&
      url.hostname === process.env.NEURON_GATEWAY_PUBLIC_HOST;
    if (
      (!local && !remote) ||
      url.pathname !== "/stream" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      return false;
  } catch {
    return false;
  }
  try {
    const endpoint = gatewayServerEndpoint(url, "/session-check");
    const tokenPath = process.env.NEURON_SESSION_TOKEN_FILE;
    if (!tokenPath || !isAbsolute(tokenPath) || !/^[0-9a-f]{32}$/.test(session.sessionId))
      return false;
    const file = lstatSync(tokenPath);
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      (file.mode & 0o077) !== 0 ||
      (process.getuid && file.uid !== process.getuid())
    )
      return false;
    const token = readFileSync(tokenPath, "utf8").trim();
    if (!/^[0-9a-fA-F]{64}$/.test(token)) return false;
    const owner = session.ownerAddress.toLowerCase();
    const signature = createHmac("sha256", Buffer.from(token, "hex"))
      .update(`session-check:${session.sessionId}:${owner}:${sellerAccount}`)
      .digest("hex");
    const response = await fetch(endpoint, {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      headers: {
        "X-Neuron-Session-ID": session.sessionId,
        "X-Neuron-Owner": owner,
        "X-Neuron-Auth": signature,
      },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return false;
    const result: unknown = await response.json();
    return Boolean(
      result &&
      typeof result === "object" &&
      (result as Record<string, unknown>).connected === true,
    );
  } catch {
    return false;
  }
}

type CommandResult = Readonly<{
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  overflow: boolean;
}>;

async function runBinary(
  file: string,
  env: Record<string, string>,
  input: Buffer,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [], {
      env: { NODE_ENV: process.env.NODE_ENV ?? "production", ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > outputLimit) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes > outputLimit) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      err.push(chunk);
    });
    child.stdin.on("error", () => {
      /* The child exit determines the result. */
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
        overflow,
      });
    });
    child.stdin.end(input);
  });
}

type DatabaseRow = {
  id: string;
  state: CustomerRequestRecord["state"];
  seller_account: string;
  transaction_id: string | null;
  payload_sha256: string | null;
  topic_sequence: number | null;
};

function asRecord(row: DatabaseRow): CustomerRequestRecord {
  return {
    id: row.id,
    state: row.state,
    sellerAccount: row.seller_account,
    transactionId: row.transaction_id,
    payloadSha256: row.payload_sha256,
    topicSequence: row.topic_sequence,
  };
}

export function latestCustomerRequest(
  session: CustomerSession,
  origin: URL,
): CustomerRequestRecord | null {
  return withCustomerDatabase((db) => {
    const row = db
      .prepare(
        "SELECT id, state, seller_account, transaction_id, payload_sha256, topic_sequence FROM customer_service_requests WHERE session_id = ? AND owner_address = ? AND origin = ?",
      )
      .get(session.sessionId, session.ownerAddress, origin.origin) as DatabaseRow | undefined;
    return row ? asRecord(row) : null;
  });
}

function reserveRequest(
  session: CustomerSession,
  origin: URL,
  seller: string,
): Readonly<{ record: CustomerRequestRecord; created: boolean }> {
  const now = Math.floor(Date.now() / 1000);
  return withCustomerDatabase((db) =>
    db
      .transaction(() => {
        // No HCS write starts while a row is reserved. A crashed preflight is safe to discard.
        db.prepare(
          "DELETE FROM customer_service_requests WHERE state = 'reserved' AND created_at < ?",
        ).run(now - 120);
        const existing = db
          .prepare(
            "SELECT id, state, seller_account, transaction_id, payload_sha256, topic_sequence FROM customer_service_requests WHERE session_id = ?",
          )
          .get(session.sessionId) as DatabaseRow | undefined;
        if (existing) return { record: asRecord(existing), created: false };
        const unresolved = db
          .prepare(
            "SELECT id FROM customer_service_requests WHERE state IN ('reserved', 'submitting', 'uncertain') LIMIT 1",
          )
          .get() as { id: string } | undefined;
        if (unresolved)
          throw new CustomerRequestConflict("A seller request needs operator reconciliation", 409);
        const recent = db
          .prepare(
            "SELECT created_at FROM customer_service_requests ORDER BY created_at DESC LIMIT 1",
          )
          .get() as { created_at: number } | undefined;
        if (recent && now - recent.created_at < 120)
          throw new CustomerRequestConflict("Wait before requesting another testnet stream", 429);
        const count = db.prepare("SELECT COUNT(*) AS n FROM customer_service_requests").get() as {
          n: number;
        };
        if (
          origin.protocol === "https:" &&
          count.n >= Number(process.env.NEURON_PUBLIC_REQUEST_LIMIT)
        ) {
          throw new CustomerRequestConflict("Public testnet request budget is exhausted", 429);
        }
        if (count.n >= 10000) throw new Error("Customer request journal reached its size limit");
        const id = randomBytes(16).toString("hex");
        db.prepare(
          "INSERT INTO customer_service_requests (id, session_id, owner_address, origin, seller_account, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)",
        ).run(id, session.sessionId, session.ownerAddress, origin.origin, seller, now, now);
        return {
          record: {
            id,
            state: "reserved" as const,
            sellerAccount: seller,
            transactionId: null,
            payloadSha256: null,
            topicSequence: null,
          },
          created: true,
        };
      })
      .immediate(),
  );
}

function updateRequest(
  id: string,
  state: CustomerRequestRecord["state"],
  payloadHash: string | null,
  transactionId: string | null,
  sequence: number | null,
): void {
  withCustomerDatabase((db) => {
    const changed = db
      .prepare(
        "UPDATE customer_service_requests SET state = ?, updated_at = ?, payload_sha256 = ?, transaction_id = ?, topic_sequence = ? WHERE id = ? AND state != 'confirmed'",
      )
      .run(state, Math.floor(Date.now() / 1000), payloadHash, transactionId, sequence, id);
    if (changed.changes !== 1) {
      const current = db
        .prepare(
          "SELECT state, payload_sha256, transaction_id FROM customer_service_requests WHERE id = ?",
        )
        .get(id) as
        { state: string; payload_sha256: string | null; transaction_id: string | null } | undefined;
      if (
        current?.state === "confirmed" &&
        current.payload_sha256 === payloadHash &&
        (transactionId === null || current.transaction_id === transactionId)
      )
        return;
      throw new Error("Customer request journal changed unexpectedly");
    }
  });
}

function releasePreflight(id: string): void {
  withCustomerDatabase((db) =>
    db.prepare("DELETE FROM customer_service_requests WHERE id = ? AND state = 'reserved'").run(id),
  );
}

export async function startCustomerRequest(
  session: CustomerSession,
  origin: URL,
  cookieToken: string | undefined,
): Promise<CustomerRequestRecord> {
  const existing = latestCustomerRequest(session, origin);
  if (existing) return existing;
  const config = requestConfig();
  if (!(await gatewayMatchesCustomer(config.seller, session)))
    throw new Error("Testnet gateway has no matching customer subscriber");
  const reservation = reserveRequest(session, origin, config.seller);
  if (!reservation.created) return reservation.record;
  const network = networkConfigFromEnv(process.env);
  let payload: Buffer;
  try {
    const direct = loadDirectSellerProfile(process.env);
    if (direct) {
      await checkDirectSellerBinding(network, direct);
    } else {
      const devices = await listLegacyDevices(network);
      const seller = devices.find((device) => device.accountId === config.seller);
      if (!seller || !seller.serviceIds.includes(1) || seller.stdinTopicId !== config.sellerTopic) {
        throw new Error("Selected seller or service is unavailable");
      }
      await checkLegacyDeviceBinding(network, seller);
    }
    const result = await runBinary(
      config.requestBinary,
      {
        HEDERA_NETWORK: "testnet",
        NEURON_SELLER_ACCOUNT_ID: config.seller,
        NEURON_SELLER_STDIN_TOPIC_ID: config.sellerTopic,
        ...(direct
          ? {
              NEURON_SELLER_DISCOVERY: "direct",
              NEURON_DIRECT_SELLER_PROFILE_FILE: process.env.NEURON_DIRECT_SELLER_PROFILE_FILE!,
              NEURON_APP_ORIGIN: process.env.NEURON_APP_ORIGIN ?? "",
              NEURON_GATEWAY_WS_URL: process.env.NEURON_GATEWAY_WS_URL ?? "",
              NEURON_ENABLE_LOCAL_STREAM: process.env.NEURON_ENABLE_LOCAL_STREAM ?? "",
              NEURON_ENABLE_REMOTE_STREAM: process.env.NEURON_ENABLE_REMOTE_STREAM ?? "",
            }
          : {}),
        HEDERA_BUYER_ACCOUNT_ID: config.buyer,
        HEDERA_BUYER_STDIN_TOPIC_ID: config.buyerTopic,
        HEDERA_SHARED_ACCOUNT_ID: config.shared,
        NEURON_PUBLIC_UDP_MULTIADDR: config.udpAddress,
        HEDERA_BUYER_KEY_FILE: config.buyerKeyFile,
      },
      Buffer.alloc(0),
      25_000,
    );
    if (
      result.code !== 0 ||
      result.timedOut ||
      result.overflow ||
      result.stdout.length < 1 ||
      result.stdout.length > 1024
    ) {
      throw new Error("Legacy service request preflight failed");
    }
    payload = result.stdout;
    const stillSignedIn = getCustomerSession(origin, cookieToken);
    if (
      !stillSignedIn ||
      stillSignedIn.sessionId !== session.sessionId ||
      stillSignedIn.ownerAddress !== session.ownerAddress
    ) {
      throw new Error("Customer session ended before service request submission");
    }
    if (!(await gatewayMatchesCustomer(config.seller, session))) {
      throw new Error("Customer WebSocket disconnected before service request submission");
    }
  } catch {
    releasePreflight(reservation.record.id);
    throw new Error("Seller request could not be prepared");
  }
  const payloadHash = createHash("sha256").update(payload).digest("hex");
  updateRequest(reservation.record.id, "submitting", payloadHash, null, null);
  let result: CommandResult;
  try {
    result = await runBinary(
      config.submitBinary,
      {
        HEDERA_NETWORK: "testnet",
        HEDERA_OPERATOR_ACCOUNT_ID: config.operator,
        HEDERA_TOPIC_ID: config.sellerTopic,
        HEDERA_OPERATOR_KEY_FILE: config.operatorKeyFile,
        HEDERA_TOPIC_ACCESS: "open",
        HEDERA_MAX_FEE_TINYBAR: config.maxFee,
      },
      payload,
      90_000,
    );
  } catch {
    updateRequest(reservation.record.id, "uncertain", payloadHash, null, null);
    throw new Error("HCS outcome is uncertain; operator reconciliation is required");
  }
  const assigned =
    /submitting HCS transaction (0\.0\.[1-9]\d*@\d+\.\d{9})/.exec(result.stderr)?.[1] ?? null;
  if (
    result.code !== 0 ||
    result.timedOut ||
    result.overflow ||
    !assigned ||
    !transactionIdPattern.test(assigned)
  ) {
    updateRequest(reservation.record.id, "uncertain", payloadHash, assigned, null);
    throw new Error("HCS outcome is uncertain; operator reconciliation is required");
  }
  let receipt: Record<string, unknown>;
  try {
    receipt = JSON.parse(result.stdout.toString("utf8")) as Record<string, unknown>;
  } catch {
    receipt = {};
  }
  if (
    receipt.network !== "testnet" ||
    receipt.topicId !== config.sellerTopic ||
    receipt.payerAccountId !== config.operator ||
    receipt.receiptStatus !== "SUCCESS" ||
    receipt.transactionId !== assigned ||
    receipt.sha256 !== payloadHash ||
    !hashPattern.test(payloadHash) ||
    !Number.isSafeInteger(receipt.sequenceNumber) ||
    (receipt.sequenceNumber as number) < 1
  ) {
    updateRequest(reservation.record.id, "uncertain", payloadHash, assigned, null);
    throw new Error("HCS receipt needs operator reconciliation");
  }
  updateRequest(
    reservation.record.id,
    "confirmed",
    payloadHash,
    assigned,
    receipt.sequenceNumber as number,
  );
  return latestCustomerRequest(session, origin)!;
}
