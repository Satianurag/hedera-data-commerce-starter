import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { getAddress, verifyMessage } from "ethers";
import { confirmEscrowFunding, getVerifiedSellerQuote, networkConfigFromEnv,
  type SellerQuote, type VerifiedSellerQuote } from "@neuron/hedera";
import { withCustomerDatabase, type CustomerSession } from "./customer-auth";

const hederaId = /^0\.0\.[1-9]\d*$/;
const positiveTinybar = /^[1-9]\d{0,17}$/;
const hexId = /^[0-9a-f]{32}$/;
const signaturePattern = /^0x[0-9a-fA-F]{130}$/;
const reviewLifetimeSeconds = 5 * 60;

export type CommerceIntent = Readonly<{
  id: string;
  state: "quoted" | "reviewed";
  network: "testnet";
  sellerAccount: string;
  quoteTopic: string;
  quoteSequence: number;
  termsHash: string;
  terms: SellerQuote;
  reviewMessage: string;
  reviewBy: number;
  reviewedAt: number | null;
}>;

export class CommerceIssue extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

type CommerceConfig = Readonly<{
  sellerAccount: string;
  quoteTopic: string;
  serviceId: string;
  escrowContractId: string;
  escrowAddress: string;
  maxSpendTinybar: bigint;
}>;

type IntentRow = {
  id: string; state: CommerceIntent["state"]; network: "testnet";
  seller_account: string; quote_topic: string; quote_sequence: number;
  terms_hash: string; terms_json: string; review_message: string;
  review_by: number; reviewed_at: number | null;
};

export function customerCommerceEnabled(origin: URL | null): boolean {
  return Boolean(origin) && process.env.NEURON_ENABLE_CUSTOMER_COMMERCE_REVIEW === "true" &&
    process.env.NEURON_ENABLE_CUSTOMER_AUTH === "true" && process.env.HEDERA_NETWORK === "testnet";
}

function commerceConfig(): CommerceConfig {
  const env = process.env;
  const sellerAccount = env.NEURON_COMMERCE_SELLER_ACCOUNT_ID ?? "";
  const quoteTopic = env.NEURON_COMMERCE_QUOTE_TOPIC_ID ?? "";
  const serviceId = env.NEURON_COMMERCE_SERVICE_ID ?? "";
  const escrowContractId = env.HEDERA_CONTRACT_ID ?? "";
  const escrowAddress = env.HEDERA_CONTRACT_ADDRESS ?? "";
  const cap = env.NEURON_COMMERCE_MAX_SPEND_TINYBAR ?? "";
  if (![sellerAccount, quoteTopic, escrowContractId].every(id => hederaId.test(id)) ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(serviceId) || !positiveTinybar.test(cap)) {
    throw new Error("Customer commerce review configuration is incomplete");
  }
  if (env.NEURON_ENABLE_CUSTOMER_APPROVAL === "true" &&
      (serviceId !== "1" || sellerAccount !== env.NEURON_SELLER_ACCOUNT_ID)) {
    throw new CommerceIssue("Buyer approval requires legacy ADS-B service 1 and the same seller account as the live customer request", 409);
  }
  let normalizedAddress: string;
  try { normalizedAddress = getAddress(escrowAddress); }
  catch { throw new Error("Customer commerce escrow address is invalid"); }
  if (normalizedAddress !== escrowAddress || normalizedAddress === getAddress("0x0000000000000000000000000000000000000000")) {
    throw new Error("Customer commerce escrow address must be a nonzero EIP-55 address");
  }
  const maxSpendTinybar = BigInt(cap);
  if (maxSpendTinybar > 100_000_000n) throw new Error("Testnet customer review cap exceeds 1 HBAR");
  return { sellerAccount, quoteTopic, serviceId, escrowContractId, escrowAddress, maxSpendTinybar };
}

export function customerCommerceDescriptor(session: CustomerSession): Readonly<{
  network: "testnet"; chainId: 296; buyerAddress: string; sessionId: string; sessionExpiresAt: number;
  sellerAccount: string; quoteTopic: string; serviceId: string; maxSpendTinybar: string;
  escrowContractId: string; escrowAddress: string;
}> {
  const config = commerceConfig();
  return { network: "testnet", chainId: 296, buyerAddress: session.ownerAddress,
    sessionId: session.sessionId, sessionExpiresAt: session.expiresAt,
    sellerAccount: config.sellerAccount, quoteTopic: config.quoteTopic,
    serviceId: config.serviceId, maxSpendTinybar: String(config.maxSpendTinybar),
    escrowContractId: config.escrowContractId, escrowAddress: config.escrowAddress };
}

function withIntentTable<T>(work: (db: Database.Database) => T): T {
  return withCustomerDatabase(db => {
    db.exec(`CREATE TABLE IF NOT EXISTS customer_commerce_intents (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL, owner_address TEXT NOT NULL, origin TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('quoted', 'reviewed')),
      network TEXT NOT NULL CHECK(network = 'testnet'),
      seller_account TEXT NOT NULL, quote_topic TEXT NOT NULL, quote_sequence INTEGER NOT NULL,
      quote_nonce TEXT NOT NULL, terms_hash TEXT NOT NULL, terms_json TEXT NOT NULL,
      review_message TEXT NOT NULL, review_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL, reviewed_at INTEGER, review_signature TEXT,
      UNIQUE(network, quote_topic, quote_sequence),
      UNIQUE(network, seller_account, quote_nonce)
    );
    CREATE INDEX IF NOT EXISTS customer_commerce_owner_idx
      ON customer_commerce_intents(session_id, owner_address, origin, created_at DESC);`);
    return work(db);
  });
}

function asIntent(row: IntentRow): CommerceIntent {
  return { id: row.id, state: row.state, network: row.network, sellerAccount: row.seller_account,
    quoteTopic: row.quote_topic, quoteSequence: row.quote_sequence, termsHash: row.terms_hash,
    terms: JSON.parse(row.terms_json) as SellerQuote, reviewMessage: row.review_message,
    reviewBy: row.review_by, reviewedAt: row.reviewed_at };
}

export function latestCommerceIntent(session: CustomerSession, origin: URL): CommerceIntent | null {
  return withIntentTable(db => {
    const row = db.prepare(`SELECT id, state, network, seller_account, quote_topic, quote_sequence,
      terms_hash, terms_json, review_message, review_by, reviewed_at
      FROM customer_commerce_intents WHERE session_id = ? AND owner_address = ? AND origin = ?
      ORDER BY created_at DESC LIMIT 1`).get(session.sessionId, session.ownerAddress, origin.origin) as IntentRow | undefined;
    return row ? asIntent(row) : null;
  });
}

export async function reverifyReviewedCommerceIntent(session: CustomerSession, origin: URL,
    id: string): Promise<Readonly<{ intent: CommerceIntent; verified: VerifiedSellerQuote }>> {
  if (!hexId.test(id)) throw new CommerceIssue("Invalid quote review reference", 400);
  const row = withIntentTable(db => db.prepare(`SELECT id, state, network, seller_account, quote_topic,
    quote_sequence, terms_hash, terms_json, review_message, review_by, reviewed_at
    FROM customer_commerce_intents WHERE id = ? AND session_id = ? AND owner_address = ? AND origin = ?`)
    .get(id, session.sessionId, session.ownerAddress, origin.origin) as IntentRow | undefined);
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.state !== "reviewed" || !row.reviewed_at || session.expiresAt <= now) {
    throw new CommerceIssue("A current wallet-reviewed quote is required", 409);
  }
  const config = commerceConfig();
  const verified = await resolveQuote(row.quote_sequence, session, config);
  if (row.quote_topic !== verified.topicId || row.seller_account !== verified.terms.sellerAccountId ||
      row.terms_hash !== verified.termsHash || row.terms_json !== JSON.stringify(verified.terms) ||
      Number(verified.terms.expiresAt) <= Math.floor(Date.now() / 1000)) {
    throw new CommerceIssue("Seller quote changed or expired after review", 409);
  }
  return { intent: asIntent(row), verified };
}

function reviewMessage(origin: URL, session: CustomerSession, verified: VerifiedSellerQuote, reviewBy: number,
    challenge: string): string {
  const t = verified.terms;
  return ["Neuron Customer App quote review", `Origin: ${origin.origin}`, "Network: Hedera testnet",
    "EVM Chain ID: 296", `Buyer wallet: ${session.ownerAddress}`, `Customer session: ${session.sessionId}`,
    `Seller account: ${t.sellerAccountId}`, `Seller payee: ${t.sellerAddress}`,
    `Service: ${t.serviceId}`, `Asset: ${t.asset}`, `Amount (tinybar): ${t.amountTinybar}`,
    `Maximum (tinybar): ${t.maxAmountTinybar}`, `Duration (seconds): ${t.durationSeconds}`,
    `Refund after (Unix seconds): ${t.refundAfter}`, `Escrow contract: ${t.escrowContractId} (${t.escrowAddress})`,
    `Seller quote HCS: ${verified.topicId} sequence ${verified.sequenceNumber}`,
    `Seller quote nonce: ${t.nonce}`, `Exact terms hash: ${verified.termsHash}`,
    `Review challenge: ${challenge}`, `Review expires at: ${new Date(reviewBy * 1000).toISOString()}`,
    "Signing records that I reviewed these exact terms. It does not fund an escrow, transfer HBAR, or approve seller withdrawal."].join("\n");
}

function quoteExpectation(config: CommerceConfig, session: CustomerSession, now: number) {
  return { sellerAccountId: config.sellerAccount, sellerTopicId: config.quoteTopic,
    buyerAddress: session.ownerAddress, serviceId: config.serviceId, sessionId: session.sessionId,
    escrowContractId: config.escrowContractId, escrowAddress: config.escrowAddress,
    maxSpendTinybar: config.maxSpendTinybar,
    nowSeconds: BigInt(now) };
}

async function resolveQuote(sequence: number, session: CustomerSession, config: CommerceConfig) {
  const network = networkConfigFromEnv(process.env);
  if (network.network !== "testnet") throw new Error("Customer commerce review is testnet-only");
  return getVerifiedSellerQuote(network, config.quoteTopic, sequence,
    quoteExpectation(config, session, Math.floor(Date.now() / 1000)));
}

export async function inspectCustomerQuote(session: CustomerSession, origin: URL, sequence: number): Promise<CommerceIntent> {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new CommerceIssue("Invalid HCS sequence", 400);
  const config = commerceConfig();
  const now = Math.floor(Date.now() / 1000);
  if (session.expiresAt <= now + 30) throw new CommerceIssue("Sign in again before reviewing a quote", 401);
  // The quote comes only from the configured seller's real HCS topic and is
  // checked against that account's current Mirror key before a row is stored.
  const verified = await resolveQuote(sequence, session, config);
  confirmEscrowFunding(verified, session.ownerAddress, verified.termsHash);
  const verifiedAt = Math.floor(Date.now() / 1000);
  const reviewBy = Math.min(Number(verified.terms.expiresAt), session.expiresAt, verifiedAt + reviewLifetimeSeconds);
  if (reviewBy <= verifiedAt + 30) throw new CommerceIssue("Seller quote or sign-in expires too soon", 422);
  return withIntentTable(db => db.transaction(() => {
    const commitTime = Math.floor(Date.now() / 1000);
    if (reviewBy <= commitTime + 30) throw new CommerceIssue("Seller quote expired before review could be stored", 422);
    const existing = db.prepare(`SELECT id, state, network, seller_account, quote_topic, quote_sequence,
      terms_hash, terms_json, review_message, review_by, reviewed_at
      FROM customer_commerce_intents WHERE network = 'testnet' AND quote_topic = ? AND quote_sequence = ?`)
      .get(verified.topicId, verified.sequenceNumber) as IntentRow | undefined;
    if (existing) {
      const row = db.prepare("SELECT session_id, owner_address, origin FROM customer_commerce_intents WHERE id = ?")
        .get(existing.id) as { session_id: string; owner_address: string; origin: string };
      if (row.session_id !== session.sessionId || row.owner_address !== session.ownerAddress ||
          row.origin !== origin.origin || existing.terms_hash !== verified.termsHash ||
          existing.terms_json !== JSON.stringify(verified.terms)) {
        throw new CommerceIssue("This seller quote reference is already reserved", 409);
      }
      return asIntent(existing);
    }
    const reusedNonce = db.prepare(`SELECT id FROM customer_commerce_intents
      WHERE network = 'testnet' AND seller_account = ? AND quote_nonce = ? LIMIT 1`)
      .get(verified.terms.sellerAccountId, verified.terms.nonce) as { id: string } | undefined;
    if (reusedNonce) throw new CommerceIssue("Seller quote nonce is already used", 409);
    const reviewed = db.prepare(`SELECT id FROM customer_commerce_intents
      WHERE session_id = ? AND owner_address = ? AND origin = ? AND state = 'reviewed' LIMIT 1`)
      .get(session.sessionId, session.ownerAddress, origin.origin) as { id: string } | undefined;
    if (reviewed) throw new CommerceIssue("This customer session already reviewed a quote", 409);
    const recent = db.prepare("SELECT COUNT(*) AS n FROM customer_commerce_intents WHERE session_id = ?")
      .get(session.sessionId) as { n: number };
    if (recent.n >= 10) throw new CommerceIssue("Too many quotes reviewed in this customer session", 429);
    const total = db.prepare("SELECT COUNT(*) AS n FROM customer_commerce_intents").get() as { n: number };
    if (total.n >= 10000) throw new Error("Customer commerce journal reached its size limit");
    const id = randomBytes(16).toString("hex");
    const message = reviewMessage(origin, session, verified, reviewBy, randomBytes(16).toString("hex"));
    db.prepare(`INSERT INTO customer_commerce_intents (id, session_id, owner_address, origin,
      state, network, seller_account, quote_topic, quote_sequence, quote_nonce, terms_hash,
      terms_json, review_message, review_by, created_at)
      VALUES (?, ?, ?, ?, 'quoted', 'testnet', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id,
      session.sessionId, session.ownerAddress, origin.origin, verified.terms.sellerAccountId,
      verified.topicId, verified.sequenceNumber, verified.terms.nonce, verified.termsHash,
      JSON.stringify(verified.terms), message, reviewBy, commitTime);
    return { id, state: "quoted", network: "testnet", sellerAccount: verified.terms.sellerAccountId,
      quoteTopic: verified.topicId, quoteSequence: verified.sequenceNumber, termsHash: verified.termsHash,
      terms: verified.terms, reviewMessage: message, reviewBy, reviewedAt: null } as CommerceIntent;
  }).immediate());
}

export async function acceptCustomerQuote(session: CustomerSession, origin: URL, id: string,
    signature: string): Promise<CommerceIntent> {
  if (!hexId.test(id) || !signaturePattern.test(signature)) throw new CommerceIssue("Invalid quote review signature", 400);
  const config = commerceConfig();
  const now = Math.floor(Date.now() / 1000);
  const stored = withIntentTable(db => db.prepare(`SELECT id, state, network, seller_account, quote_topic,
    quote_sequence, terms_hash, terms_json, review_message, review_by, reviewed_at
    FROM customer_commerce_intents WHERE id = ? AND session_id = ? AND owner_address = ? AND origin = ?`)
    .get(id, session.sessionId, session.ownerAddress, origin.origin) as IntentRow | undefined);
  if (!stored || stored.state !== "quoted" || stored.review_by <= now || session.expiresAt <= now) {
    throw new CommerceIssue("Quote review is missing, expired or already used", 409);
  }
  let signer: string;
  try { signer = getAddress(verifyMessage(stored.review_message, signature)); }
  catch { throw new CommerceIssue("Wallet review signature is invalid", 401); }
  if (signer !== session.ownerAddress) throw new CommerceIssue("Wallet review signature does not match the buyer", 401);
  // A stale database row is never sufficient to accept a quote. Re-read HCS
  // and the seller's current Mirror key immediately before recording review.
  // A future funding path must repeat this check and independently verify the
  // deployed contract ID/address, runtime code, expiry/renewal and refund path
  // before it asks the wallet to send any HBAR.
  const verified = await resolveQuote(stored.quote_sequence, session, config);
  if (stored.quote_topic !== verified.topicId || stored.seller_account !== verified.terms.sellerAccountId ||
      stored.terms_hash !== verified.termsHash || stored.terms_json !== JSON.stringify(verified.terms)) {
    throw new CommerceIssue("Seller quote changed since inspection", 409);
  }
  return withIntentTable(db => db.transaction(() => {
    const commitTime = Math.floor(Date.now() / 1000);
    if (session.expiresAt <= commitTime || stored.review_by <= commitTime) {
      throw new CommerceIssue("Quote review expired during verification", 409);
    }
    const other = db.prepare(`SELECT id FROM customer_commerce_intents
      WHERE session_id = ? AND state = 'reviewed' LIMIT 1`).get(session.sessionId) as { id: string } | undefined;
    if (other) throw new CommerceIssue("This customer session already reviewed a quote", 409);
    const changed = db.prepare(`UPDATE customer_commerce_intents SET state = 'reviewed', reviewed_at = ?, review_signature = ?
      WHERE id = ? AND session_id = ? AND owner_address = ? AND origin = ? AND state = 'quoted' AND review_by > ?`)
      .run(commitTime, signature, id, session.sessionId, session.ownerAddress, origin.origin, commitTime);
    if (changed.changes !== 1) throw new CommerceIssue("Quote review changed or expired", 409);
    const row = db.prepare(`SELECT id, state, network, seller_account, quote_topic, quote_sequence,
      terms_hash, terms_json, review_message, review_by, reviewed_at
      FROM customer_commerce_intents WHERE id = ?`).get(id) as IntentRow;
    return asIntent(row);
  }).immediate());
}
