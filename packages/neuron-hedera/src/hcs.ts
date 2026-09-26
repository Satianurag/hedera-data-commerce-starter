import { getMirrorTopic, mirrorJson } from "./mirror.js";
import { assertHederaId, type NetworkConfig } from "./network.js";

type TransactionId = {
  account_id: string;
  transaction_valid_start: string;
  nonce: number;
  scheduled: boolean;
};

type ChunkInfo = {
  initial_transaction_id: TransactionId;
  number: number;
  total: number;
};

type MirrorMessage = {
  chunk_info: ChunkInfo | null;
  consensus_timestamp: string;
  message: string;
  payer_account_id: string;
  sequence_number: number;
  topic_id: string;
};

export type TopicMessage = Readonly<{
  topicId: string;
  payerAccountId: string;
  consensusTimestamp: string;
  sequenceNumber: number;
  initialTransactionId: Readonly<TransactionId> | null;
  bytes: Uint8Array;
}>;

function parseMessage(value: unknown, topicId: string): MirrorMessage {
  if (!value || typeof value !== "object") throw new Error("Malformed Mirror message");
  const row = value as Partial<MirrorMessage>;
  if (row.topic_id !== topicId || !Number.isSafeInteger(row.sequence_number) ||
      (row.sequence_number as number) < 1 || typeof row.message !== "string" ||
      typeof row.payer_account_id !== "string" ||
      typeof row.consensus_timestamp !== "string" ||
      !/^\d+\.\d{1,9}$/.test(row.consensus_timestamp)) {
    throw new Error("Malformed Mirror message");
  }
  assertHederaId(row.payer_account_id, "payer_account_id");
  const info = row.chunk_info ?? null;
  if (info !== null) {
    if (typeof info !== "object" || Array.isArray(info)) {
      throw new Error("Malformed Mirror chunk metadata");
    }
    const id = info.initial_transaction_id;
    if (!id || !Number.isSafeInteger(info.number) || !Number.isSafeInteger(info.total) ||
        info.number < 1 || info.total < 1 || info.number > info.total || info.total > 20 ||
        typeof id.account_id !== "string" ||
        typeof id.transaction_valid_start !== "string" ||
        !/^\d+\.\d{1,9}$/.test(id.transaction_valid_start) ||
        !Number.isSafeInteger(id.nonce) || typeof id.scheduled !== "boolean") {
      throw new Error("Malformed Mirror chunk metadata or unsupported chunk count");
    }
    assertHederaId(id.account_id, "initial transaction account");
  }
  return { ...row, chunk_info: info } as MirrorMessage;
}

function bytesFromBase64(value: string): Buffer {
  if (value.length > 1368) throw new Error("Invalid HCS chunk encoding or size");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > 1024 || bytes.toString("base64") !== value) {
    throw new Error("Invalid HCS chunk encoding or size");
  }
  return bytes;
}

function transactionKey(id: TransactionId): string {
  return `${id.account_id}@${id.transaction_valid_start}/${id.nonce}/${id.scheduled}`;
}

export function latestTopicMessageFromRows(rows: readonly unknown[], topicId: string): TopicMessage | null {
  if (!rows.length) return null;
  const first = parseMessage(rows[0], topicId);
  const firstInfo = first.chunk_info;
  if (!firstInfo || firstInfo.total === 1) {
    return {
      topicId,
      payerAccountId: first.payer_account_id,
      consensusTimestamp: first.consensus_timestamp,
      sequenceNumber: first.sequence_number,
      initialTransactionId: firstInfo?.initial_transaction_id ?? null,
      bytes: bytesFromBase64(first.message),
    };
  }

  const chunks = new Map<number, MirrorMessage>([[firstInfo.number, first]]);
  const key = transactionKey(firstInfo.initial_transaction_id);
  for (let i = 1; i < rows.length && chunks.size < firstInfo.total; i++) {
    const raw = rows[i];
    const possibleInfo = (raw as Partial<MirrorMessage> | null)?.chunk_info;
    if (!possibleInfo || typeof possibleInfo !== "object" ||
        !possibleInfo.initial_transaction_id ||
        transactionKey(possibleInfo.initial_transaction_id) !== key) continue;
    const row = parseMessage(raw, topicId);
    const info = row.chunk_info;
    if (!info) continue;
    if (info.total !== firstInfo.total || row.payer_account_id !== first.payer_account_id ||
        chunks.has(info.number)) {
      throw new Error("Inconsistent or duplicate HCS chunk");
    }
    chunks.set(info.number, row);
  }
  if (chunks.size !== firstInfo.total) return null;
  const ordered = Array.from({ length: firstInfo.total }, (_, i) => chunks.get(i + 1));
  if (ordered.some(chunk => !chunk)) throw new Error("Missing HCS chunk");
  const latest = ordered.reduce((a, b) => b!.sequence_number > a!.sequence_number ? b : a)!;
  return {
    topicId,
    payerAccountId: first.payer_account_id,
    consensusTimestamp: latest.consensus_timestamp,
    sequenceNumber: latest.sequence_number,
    initialTransactionId: firstInfo.initial_transaction_id,
    bytes: Buffer.concat(ordered.map(chunk => bytesFromBase64(chunk!.message))),
  };
}

export async function getLatestTopicMessage(config: NetworkConfig, topicId: string): Promise<TopicMessage | null> {
  assertHederaId(topicId, "topicId");
  await getMirrorTopic(config, topicId);
  let path: string | null = `/api/v1/topics/${topicId}/messages?limit=25&order=desc`;
  const rows: unknown[] = [];

  for (let page = 0; path && page < 5; page++) {
    const data = await mirrorJson(config, path) as {
      messages?: unknown;
      links?: { next?: unknown };
    };
    if (!Array.isArray(data.messages) || data.messages.length > 25) {
      throw new Error("Malformed or oversized Mirror message page");
    }
    rows.push(...data.messages);
    const latest = latestTopicMessageFromRows(rows, topicId);
    if (latest) return latest;
    const next = data.links?.next;
    if (next !== null && next !== undefined &&
        (typeof next !== "string" || !next.startsWith(`/api/v1/topics/${topicId}/messages?`))) {
      throw new Error("Mirror pagination link escaped the selected topic");
    }
    path = typeof next === "string" ? next : null;
    if (!path && rows.length === 0) return null;
    if (!path) break;
  }
  throw new Error(`Latest HCS message incomplete within pagination bound on ${config.network}`);
}
