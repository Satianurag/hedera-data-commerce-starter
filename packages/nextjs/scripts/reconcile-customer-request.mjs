import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import Database from "better-sqlite3";

const idPattern = /^[0-9a-f]{32}$/;
const hederaId = /^0\.0\.[1-9]\d*$/;
const transactionPattern = /^(0\.0\.[1-9]\d*)@(\d{10})\.(\d{9})$/;
const timestampPattern = /^\d{10}\.\d{9}$/;
const hashPattern = /^[0-9a-f]{64}$/;

function ownerDatabasePath() {
  const file = process.env.NEURON_CUSTOMER_DB_FILE;
  if (!file || !isAbsolute(file)) throw new Error("NEURON_CUSTOMER_DB_FILE must be an absolute path");
  const parentInfo = lstatSync(dirname(file));
  const fileInfo = lstatSync(file);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || (parentInfo.mode & 0o077) !== 0 ||
      !fileInfo.isFile() || fileInfo.isSymbolicLink() || (fileInfo.mode & 0o077) !== 0 ||
      (process.getuid && (parentInfo.uid !== process.getuid() || fileInfo.uid !== process.getuid()))) {
    throw new Error("Customer request database must be an owner-only regular file in an owner-only directory");
  }
  return file;
}

async function mirrorJSON(path) {
  const response = await fetch(`https://testnet.mirrornode.hedera.com/api/v1${path}`, {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Mirror returned HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Mirror response has no body");
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 64 * 1024) { await reader.cancel(); throw new Error("Mirror response exceeds 64 KiB"); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function exactMessageBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("Mirror message is not canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 1 || bytes.length > 1024 || bytes.toString("base64") !== value) {
    throw new Error("Mirror message bytes are invalid");
  }
  return bytes;
}

async function main() {
  const requestId = process.argv[2];
  if (!idPattern.test(requestId ?? "") || process.argv.length !== 3) {
    throw new Error("Usage: npm run request:reconcile -w @neuron/nextjs -- <32-hex-request-id>");
  }
  if (process.env.HEDERA_NETWORK !== "testnet" ||
      !hederaId.test(process.env.HEDERA_OPERATOR_ACCOUNT_ID ?? "") ||
      !hederaId.test(process.env.NEURON_SELLER_STDIN_TOPIC_ID ?? "")) {
    throw new Error("Explicit testnet, HCS operator and seller stdin topic are required");
  }
  const db = new Database(ownerDatabasePath(), { fileMustExist: true, timeout: 5000 });
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    const row = db.prepare("SELECT id, state, updated_at, transaction_id, payload_sha256, topic_sequence FROM customer_service_requests WHERE id = ?")
      .get(requestId);
    if (!row) throw new Error("Request journal ID is missing");
    if (row.state === "confirmed") {
      console.log(JSON.stringify({ id: row.id, state: row.state, transactionId: row.transaction_id,
        topicSequence: row.topic_sequence, payloadSha256: row.payload_sha256 }));
      return;
    }
    if (!(["submitting", "uncertain"].includes(row.state)) ||
        !transactionPattern.test(row.transaction_id ?? "") || !hashPattern.test(row.payload_sha256 ?? "")) {
      throw new Error("Request has no exact transaction ID and payload hash; keep it blocked for manual investigation");
    }
    if (row.state === "submitting" && Math.floor(Date.now() / 1000) - row.updated_at < 120) {
      throw new Error("Request may still be in flight; wait at least 120 seconds before reconciliation");
    }
    const match = transactionPattern.exec(row.transaction_id);
    if (match[1] !== process.env.HEDERA_OPERATOR_ACCOUNT_ID) {
      throw new Error("Journal transaction payer does not match the configured operator");
    }
    const mirrorId = `${match[1]}-${match[2]}-${match[3]}`;
    const transaction = await mirrorJSON(`/transactions/${mirrorId}`);
    const success = Array.isArray(transaction.transactions) ? transaction.transactions.filter(item =>
      item?.transaction_id === mirrorId && item.name === "CONSENSUSSUBMITMESSAGE" && item.result === "SUCCESS" &&
      timestampPattern.test(item.consensus_timestamp ?? "")) : [];
    if (success.length !== 1) throw new Error("Mirror does not show one successful HCS transaction; request remains blocked");
    const consensus = success[0].consensus_timestamp;
    const message = await mirrorJSON(`/topics/messages/${consensus}`);
    const bytes = exactMessageBytes(message.message);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (message.consensus_timestamp !== consensus ||
        message.topic_id !== process.env.NEURON_SELLER_STDIN_TOPIC_ID ||
        message.payer_account_id !== process.env.HEDERA_OPERATOR_ACCOUNT_ID ||
        hash !== row.payload_sha256 ||
        !Number.isSafeInteger(message.sequence_number) || message.sequence_number < 1 ||
        (message.chunk_info && (message.chunk_info.total !== 1 || message.chunk_info.number !== 1))) {
      throw new Error("Mirror payer, topic, bytes, sequence or chunk metadata mismatch; request remains blocked");
    }
    const update = db.transaction(() => db.prepare("UPDATE customer_service_requests SET state = 'confirmed', updated_at = ?, topic_sequence = ? WHERE id = ? AND state IN ('submitting', 'uncertain') AND transaction_id = ? AND payload_sha256 = ?")
      .run(Math.floor(Date.now() / 1000), message.sequence_number, requestId, row.transaction_id, row.payload_sha256));
    if (update.immediate().changes !== 1) throw new Error("Request changed during reconciliation; inspect it again");
    console.log(JSON.stringify({ id: requestId, state: "confirmed", transactionId: row.transaction_id,
      topicSequence: message.sequence_number, payloadSha256: row.payload_sha256 }));
  } finally { db.close(); }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Customer request reconciliation failed");
  process.exitCode = 1;
});
