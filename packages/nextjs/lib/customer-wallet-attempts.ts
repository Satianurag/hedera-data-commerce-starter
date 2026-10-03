import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { CommerceIssue } from "./customer-commerce";

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
export type AttemptKind = "funding" | "refund" | "approval";
export function walletAttemptTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS customer_wallet_attempts (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, intent_id TEXT NOT NULL,
    owner_address TEXT NOT NULL, origin TEXT NOT NULL, nonce TEXT,
    transaction_json TEXT NOT NULL, opened_at INTEGER NOT NULL,
    reported_hash TEXT, previous_state TEXT NOT NULL, legacy_open_count INTEGER NOT NULL DEFAULT 0
  ); CREATE INDEX IF NOT EXISTS customer_wallet_nonce_idx
    ON customer_wallet_attempts(owner_address, nonce);`);
  // Upgrade the initial recovery-journal schema without discarding any opening.
  // One transaction can be returned by several same-nonce wallet requests.
  const schema = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'customer_wallet_attempts'")
    .get() as { sql: string };
  if (/reported_hash TEXT UNIQUE/.test(schema.sql)) {
    db.transaction(() => {
      db.exec(`ALTER TABLE customer_wallet_attempts RENAME TO customer_wallet_attempts_v0;
        DROP INDEX customer_wallet_nonce_idx;`);
      walletAttemptTable(db);
      db.exec(`INSERT INTO customer_wallet_attempts SELECT * FROM customer_wallet_attempts_v0;
        DROP TABLE customer_wallet_attempts_v0;`);
    }).immediate();
  }
}
function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new Error("Wallet nonce is not a canonical RPC quantity");
  }
  return BigInt(value);
}
export async function walletNonce(
  rpc: Rpc,
  owner: string,
  previousJson?: string,
  failed = false,
  proveConsumedOutcome?: (blockTag: string) => Promise<void>,
): Promise<string> {
  const block = (await rpc("eth_getBlockByNumber", ["latest", false])) as {
    number?: unknown;
  } | null;
  const blockTag = `0x${quantity(block?.number).toString(16)}`;
  const [latest, pending] = await Promise.all([
    rpc("eth_getTransactionCount", [owner, blockTag]),
    rpc("eth_getTransactionCount", [owner, "pending"]),
  ]);
  const mined = quantity(latest),
    queued = quantity(pending);
  if (queued < mined) throw new Error("RPC nonce observations disagree");
  const previous = previousJson ? (JSON.parse(previousJson) as { nonce?: string }) : null;
  if (previous?.nonce && !failed) {
    const original = quantity(previous.nonce);
    if (mined > original) {
      if (!proveConsumedOutcome)
        throw new CommerceIssue(
          "The original nonce was consumed; reconcile its transaction or successful escrow event before retrying",
          409,
        );
      if (queued !== mined)
        throw new CommerceIssue("Another wallet transaction is pending; reconcile it first", 409);
      await proveConsumedOutcome(blockTag);
      return `0x${mined.toString(16)}`;
    }
    if (mined !== original)
      throw new CommerceIssue("Earlier wallet transactions must settle before retrying", 409);
    return `0x${original.toString(16)}`;
  }
  if (failed && previous?.nonce && mined <= quantity(previous.nonce)) {
    throw new CommerceIssue("The failed transaction nonce is not yet final on RPC", 409);
  }
  if (queued !== mined)
    throw new CommerceIssue(
      "Another wallet transaction is pending; reconcile it before opening this wallet action",
      409,
    );
  return `0x${mined.toString(16)}`;
}
// Caller holds the same IMMEDIATE transaction as its wallet-opened marker.
// Preserve old rows with unknown nonces instead of fabricating migrated history.
export function recordWalletAttempt(
  db: Database.Database,
  kind: AttemptKind,
  row: {
    id: string;
    owner_address: string;
    origin: string;
    transaction_json: string;
    transaction_hash: string | null;
    state: string;
    wallet_attempt_id?: string | null;
    wallet_open_count?: number;
  },
  transaction: { nonce?: string },
  openedAt: number,
  legacyOpenedAt: number | null,
): string {
  walletAttemptTable(db);
  if (legacyOpenedAt !== null && !row.wallet_attempt_id) {
    db.prepare(
      `INSERT INTO customer_wallet_attempts
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    ).run(
      randomBytes(16).toString("hex"),
      kind,
      row.id,
      row.owner_address,
      row.origin,
      row.transaction_json,
      legacyOpenedAt,
      row.transaction_hash,
      row.state,
      row.wallet_open_count ?? 1,
    );
  }
  if (!transaction.nonce) throw new Error("Wallet opening requires a durable nonce");
  const reserved = db
    .prepare(
      `SELECT kind, intent_id FROM customer_wallet_attempts
    WHERE owner_address = ? AND nonce = ? AND (kind != ? OR intent_id != ?)`,
    )
    .all(row.owner_address, transaction.nonce, kind, row.id) as {
    kind: AttemptKind;
    intent_id: string;
  }[];
  for (const previous of reserved) {
    // An abandoned funding call can never succeed after its proven expiry.
    const closed =
      previous.kind === "funding" &&
      (db
        .prepare(
          `SELECT abandoned_at
      FROM customer_funding_intents WHERE id = ?`,
        )
        .get(previous.intent_id) as { abandoned_at: number | null } | false | undefined);
    if (!closed || closed.abandoned_at === null) {
      throw new CommerceIssue(
        "This wallet nonce belongs to another durable intent; reconcile it first",
        409,
      );
    }
  }
  const id = randomBytes(16).toString("hex");
  db.prepare(
    `INSERT INTO customer_wallet_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0)`,
  ).run(
    id,
    kind,
    row.id,
    row.owner_address,
    row.origin,
    transaction.nonce,
    JSON.stringify(transaction),
    openedAt,
    row.state,
  );
  return id;
}
export function attachWalletAttempt(
  db: Database.Database,
  kind: AttemptKind,
  row: { id: string; wallet_attempt_id?: string | null },
  hash: string,
  attemptId?: string,
): boolean {
  if (!row.wallet_attempt_id) {
    if (attemptId) throw new CommerceIssue("Unknown wallet attempt", 409);
    return true; // Legacy clients with a single durable opening.
  }
  if (!attemptId || !/^[0-9a-f]{32}$/.test(attemptId)) {
    throw new CommerceIssue("The wallet opening reference is required to save this hash", 409);
  }
  const attempt = db
    .prepare(
      `SELECT reported_hash FROM customer_wallet_attempts
    WHERE id = ? AND kind = ? AND intent_id = ?`,
    )
    .get(attemptId, kind, row.id) as { reported_hash: string | null } | undefined;
  if (!attempt || (attempt.reported_hash && attempt.reported_hash !== hash)) {
    throw new CommerceIssue("Hash conflicts with its original wallet opening", 409);
  }
  const conflict = db
    .prepare(
      `SELECT id FROM customer_wallet_attempts WHERE reported_hash = ?
    AND (kind != ? OR intent_id != ?) LIMIT 1`,
    )
    .get(hash, kind, row.id);
  if (conflict) throw new CommerceIssue("Transaction hash already belongs to another intent", 409);
  db.prepare("UPDATE customer_wallet_attempts SET reported_hash = ? WHERE id = ?").run(
    hash,
    attemptId,
  );
  return attemptId === row.wallet_attempt_id;
}
