import { walletAttemptTable, walletNonce, recordWalletAttempt, attachWalletAttempt } from "./customer-wallet-attempts";
import { currentCommerceSession, assertRefundReceiptHashes } from "./commerce-guards";
import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { Interface, computeAddress, getAddress, zeroPadValue } from "ethers";
import { assertEvmRpcNetwork, confirmEscrowFunding, networkConfigFromEnv,
  type VerifiedSellerQuote } from "@neuron/hedera";
import { withCustomerDatabase, type CustomerSession } from "./customer-auth";
import { CommerceIssue, reverifyReviewedCommerceIntent } from "./customer-commerce";

const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const idPattern = /^[0-9a-f]{32}$/;
const asQuantity = (value: bigint): string => `0x${value.toString(16)}`;
const escrowAbi = [
  "function fund(address seller,uint64 quoteExpiresAt,uint64 refundAfter,bytes32 termsHash) payable returns (uint256)",
  "function usedTermsHash(address buyer,bytes32 termsHash) view returns (bool)",
  "function escrows(uint256 id) view returns (address buyer,address seller,uint256 amount,uint64 quoteExpiresAt,uint64 refundAfter,bytes32 termsHash,uint8 state)",
  "function approve(uint256 id)",
  "function withdraw(uint256 id)",
  "function refund(uint256 id)",
  "event Funded(uint256 indexed id,address indexed buyer,address seller,uint256 amount,uint64 quoteExpiresAt,uint64 refundAfter,bytes32 indexed termsHash)",
  "event Approved(uint256 indexed id,address indexed buyer)",
  "event Released(uint256 indexed id,address indexed seller,address to,uint256 amount)",
  "event Refunded(uint256 indexed id,address indexed buyer,address to,uint256 amount)",
] as const;
const escrowInterface = new Interface(escrowAbi);
const escrowAbiJson = JSON.stringify(escrowAbi);

function pinnedInterface(abiJson: string | null): Interface {
  if (!abiJson || abiJson.length > 8192) throw new Error("Original funded escrow ABI was not pinned");
  const abi = JSON.parse(abiJson) as unknown;
  if (!Array.isArray(abi) || abi.length < 6 || abi.length > 20 ||
      !abi.every(fragment => typeof fragment === "string" && fragment.length < 500)) {
    throw new Error("Original funded escrow ABI is malformed");
  }
  return new Interface(abi);
}

type FundingState = "prepared" | "submitted" | "executed" | "failed" | "conflict" | "abandoned";
type ContractState = "funded" | "approved" | "paid" | "refunded" | null;
type WalletTransaction = Readonly<{
  from: string; to: string; value: string; data: string; gas: string; gasPrice: string; chainId: "0x128"; nonce?: string;
}>;
export type FundingRecord = Readonly<{
  walletAttemptId?: string | null; id: string; quoteIntentId: string; state: FundingState; contractState: ContractState;
  walletOpenedAt: number | null; runtimeSha256: string | null; abiPinned: boolean;
  abandonedAt: number | null;
  transactionHash: string | null; reportedHash: string | null; observedHash: string | null;
  escrowId: string | null; termsHash: string;
  contractId: string; contractAddress: string; sellerAccountId: string | null;
  sellerAddress: string; amountTinybar: string;
  quoteExpiresAt: number; refundAfter: number; preparedAt: number;
  settlementHash: string | null; settlementMirrorTimestamp: string | null;
  settlementRecipientAddress: string | null; settlementAmountTinybar: string | null;
  settlementVerifiedAt: number | null;
}>;
export type RefundRecord = Readonly<{
  walletAttemptId?: string | null; id: string; fundingId: string; state: FundingState; escrowId: string;
  walletOpenedAt: number | null; walletOpenCount: number;
  transactionHash: string | null; reportedHash: string | null; observedHash: string | null;
  amountTinybar: string; preparedAt: number;
}>;

type FundingRow = {
  wallet_attempt_id: string | null;
  id: string; quote_intent_id: string; state: FundingState; contract_state: ContractState;
  transaction_hash: string | null; observed_hash: string | null; confirmed_hash: string | null;
  escrow_id: string | null; terms_hash: string;
  contract_id: string; contract_address: string; seller_account_id: string | null;
  seller_public_key: string | null; seller_address: string; amount_tinybar: string;
  quote_expires_at: number; refund_after: number; prepared_at: number;
  prepared_block: number; scan_next_block: number; transaction_json: string; session_id: string;
  wallet_opened_at: number | null; runtime_sha256: string | null; abi_json: string | null;
  abandoned_at: number | null; abandon_scan_next_block: number | null;
  settlement_hash: string | null;
  settlement_mirror_timestamp: string | null; settlement_recipient_address: string | null;
  settlement_amount_tinybar: string | null; settlement_verified_at: number | null;
  owner_address: string; origin: string;
};
type RefundRow = {
  wallet_attempt_id: string | null;
  id: string; funding_id: string; state: FundingState; escrow_id: string;
  session_id: string; owner_address: string; origin: string;
  contract_id: string; contract_address: string; amount_tinybar: string;
  prepared_block: number; scan_next_block: number; prepared_at: number;
  transaction_json: string; transaction_hash: string | null;
  wallet_opened_at: number | null; wallet_open_count: number; abi_json: string | null;
  observed_hash: string | null; confirmed_hash: string | null;
};

function withFundingTable<T>(work: (db: Database.Database) => T): T {
  return withCustomerDatabase(db => {
    db.exec(`CREATE TABLE IF NOT EXISTS customer_funding_intents (
      id TEXT PRIMARY KEY, quote_intent_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL, owner_address TEXT NOT NULL, origin TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared', 'submitted', 'executed', 'failed', 'conflict')),
      contract_state TEXT CHECK(contract_state IN ('funded', 'approved', 'paid', 'refunded')),
      contract_id TEXT NOT NULL, contract_address TEXT NOT NULL, seller_address TEXT NOT NULL,
      seller_account_id TEXT, seller_public_key TEXT,
      terms_hash TEXT NOT NULL UNIQUE, amount_tinybar TEXT NOT NULL,
      quote_expires_at INTEGER NOT NULL, refund_after INTEGER NOT NULL,
      prepared_block INTEGER NOT NULL, scan_next_block INTEGER NOT NULL, prepared_at INTEGER NOT NULL,
      transaction_json TEXT NOT NULL, transaction_hash TEXT UNIQUE,
      wallet_opened_at INTEGER, runtime_sha256 TEXT, abi_json TEXT,
      abandoned_at INTEGER, abandon_scan_next_block INTEGER,
      observed_hash TEXT UNIQUE, confirmed_hash TEXT UNIQUE,
      escrow_id TEXT, settlement_hash TEXT UNIQUE,
      settlement_mirror_timestamp TEXT, settlement_recipient_address TEXT,
      settlement_amount_tinybar TEXT, settlement_verified_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS customer_funding_history_idx
      ON customer_funding_intents(owner_address, origin, prepared_at DESC, id DESC);`);
    const columns = db.pragma("table_info(customer_funding_intents)") as { name: string }[];
    walletAttemptTable(db);
    if (!columns.some(column => column.name === "wallet_attempt_id")) {
      db.exec("ALTER TABLE customer_funding_intents ADD COLUMN wallet_attempt_id TEXT");
    }
    if (!columns.some(column => column.name === "wallet_opened_at")) {
      db.exec("ALTER TABLE customer_funding_intents ADD COLUMN wallet_opened_at INTEGER");
    }
    if (!columns.some(column => column.name === "runtime_sha256")) {
      db.exec("ALTER TABLE customer_funding_intents ADD COLUMN runtime_sha256 TEXT");
    }
    if (!columns.some(column => column.name === "abi_json")) {
      db.exec("ALTER TABLE customer_funding_intents ADD COLUMN abi_json TEXT");
    }
    if (!columns.some(column => column.name === "abandoned_at")) {
      db.exec("ALTER TABLE customer_funding_intents ADD COLUMN abandoned_at INTEGER");
    }
    if (!columns.some(column => column.name === "abandon_scan_next_block")) {
      db.exec("ALTER TABLE customer_funding_intents ADD COLUMN abandon_scan_next_block INTEGER");
    }
    if (!columns.some(column => column.name === "settlement_hash")) {
      db.exec("ALTER TABLE customer_funding_intents ADD COLUMN settlement_hash TEXT");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS customer_funding_settlement_hash_idx ON customer_funding_intents(settlement_hash)");
    }
    if (!columns.some(column => column.name === "settlement_mirror_timestamp")) {
      db.exec("ALTER TABLE customer_funding_intents ADD COLUMN settlement_mirror_timestamp TEXT");
    }
    if (!columns.some(column => column.name === "settlement_recipient_address")) {
      db.exec("ALTER TABLE customer_funding_intents ADD COLUMN settlement_recipient_address TEXT");
    }
    if (!columns.some(column => column.name === "settlement_amount_tinybar")) {
      db.exec("ALTER TABLE customer_funding_intents ADD COLUMN settlement_amount_tinybar TEXT");
    }
    if (!columns.some(column => column.name === "settlement_verified_at")) {
      db.exec("ALTER TABLE customer_funding_intents ADD COLUMN settlement_verified_at INTEGER");
    }
    if (!columns.some(column => column.name === "seller_account_id")) {
      db.exec("ALTER TABLE customer_funding_intents ADD COLUMN seller_account_id TEXT");
    }
    if (!columns.some(column => column.name === "seller_public_key")) {
      db.exec("ALTER TABLE customer_funding_intents ADD COLUMN seller_public_key TEXT");
    }
    return work(db);
  });
}

function withRefundTable<T>(work: (db: Database.Database) => T): T {
  return withCustomerDatabase(db => {
    db.exec(`CREATE TABLE IF NOT EXISTS customer_refund_intents (
      id TEXT PRIMARY KEY, funding_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL, owner_address TEXT NOT NULL, origin TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared', 'submitted', 'executed', 'failed', 'conflict')),
      escrow_id TEXT NOT NULL, contract_id TEXT NOT NULL, contract_address TEXT NOT NULL,
      amount_tinybar TEXT NOT NULL, prepared_block INTEGER NOT NULL,
      scan_next_block INTEGER NOT NULL, prepared_at INTEGER NOT NULL,
      transaction_json TEXT NOT NULL, transaction_hash TEXT UNIQUE,
      wallet_opened_at INTEGER, wallet_open_count INTEGER NOT NULL DEFAULT 0, abi_json TEXT,
      observed_hash TEXT UNIQUE, confirmed_hash TEXT UNIQUE, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS customer_refund_owner_idx
      ON customer_refund_intents(owner_address, origin, prepared_at DESC);`);
    const columns = db.pragma("table_info(customer_refund_intents)") as { name: string }[];
    walletAttemptTable(db);
    if (!columns.some(column => column.name === "wallet_attempt_id")) {
      db.exec("ALTER TABLE customer_refund_intents ADD COLUMN wallet_attempt_id TEXT");
    }
    if (!columns.some(column => column.name === "wallet_opened_at")) {
      db.exec("ALTER TABLE customer_refund_intents ADD COLUMN wallet_opened_at INTEGER");
    }
    if (!columns.some(column => column.name === "abi_json")) {
      db.exec("ALTER TABLE customer_refund_intents ADD COLUMN abi_json TEXT");
    }
    if (!columns.some(column => column.name === "wallet_open_count")) {
      db.exec("ALTER TABLE customer_refund_intents ADD COLUMN wallet_open_count INTEGER NOT NULL DEFAULT 0");
    }
    return work(db);
  });
}

function asRecord(row: FundingRow): FundingRecord {
  return { walletAttemptId: row.wallet_attempt_id, id: row.id, quoteIntentId: row.quote_intent_id,
    state: row.abandoned_at === null ? row.state : "abandoned",
    contractState: row.contract_state, walletOpenedAt: row.wallet_opened_at,
    runtimeSha256: row.runtime_sha256, abiPinned: row.abi_json !== null,
    abandonedAt: row.abandoned_at,
    transactionHash: row.confirmed_hash ?? row.observed_hash ?? row.transaction_hash,
    reportedHash: row.transaction_hash, observedHash: row.observed_hash,
    escrowId: row.escrow_id, termsHash: row.terms_hash, contractId: row.contract_id,
    contractAddress: row.contract_address, sellerAccountId: row.seller_account_id,
    sellerAddress: row.seller_address,
    amountTinybar: row.amount_tinybar,
    quoteExpiresAt: row.quote_expires_at, refundAfter: row.refund_after,
    preparedAt: row.prepared_at, settlementHash: row.settlement_hash,
    settlementMirrorTimestamp: row.settlement_mirror_timestamp,
    settlementRecipientAddress: row.settlement_recipient_address,
    settlementAmountTinybar: row.settlement_amount_tinybar,
    settlementVerifiedAt: row.settlement_verified_at };
}

function asRefund(row: RefundRow): RefundRecord {
  return { walletAttemptId: row.wallet_attempt_id, id: row.id, fundingId: row.funding_id, state: row.state, escrowId: row.escrow_id,
    walletOpenedAt: row.wallet_opened_at, walletOpenCount: row.wallet_open_count,
    transactionHash: row.confirmed_hash ?? row.observed_hash ?? row.transaction_hash,
    reportedHash: row.transaction_hash, observedHash: row.observed_hash,
    amountTinybar: row.amount_tinybar, preparedAt: row.prepared_at };
}

function feeCapTinybar(): bigint {
  const maxFee = process.env.NEURON_COMMERCE_MAX_TX_FEE_TINYBAR ?? "";
  if (!/^[1-9]\d{0,8}$/.test(maxFee) || BigInt(maxFee) > 100_000_000n) {
    throw new Error("Buyer transaction fee cap must be at most 1 HBAR");
  }
  return BigInt(maxFee);
}

function fundingConfig(): Readonly<{ expectedRuntimeSha256: string; maxFeeTinybar: bigint }> {
  const expectedRuntimeSha256 = process.env.NEURON_ESCROW_RUNTIME_SHA256 ?? "";
  if (!/^[0-9a-f]{64}$/.test(expectedRuntimeSha256)) {
    throw new Error("Funding requires the exact deployed runtime SHA-256");
  }
  return { expectedRuntimeSha256, maxFeeTinybar: feeCapTinybar() };
}

async function limitedJson(response: Response, maxBytes = 1_048_576): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Network response has no body");
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Error("Network response is too large"); }
    parts.push(value);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const config = networkConfigFromEnv(process.env);
  if (config.network !== "testnet" || !config.rpcUrl) throw new Error("Customer funding requires an explicit testnet EVM RPC");
  const response = await fetch(config.rpcUrl, { method: "POST", redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(10_000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!response.ok) throw new Error(`Testnet RPC returned ${response.status}`);
  const body = await limitedJson(response) as { jsonrpc?: unknown; id?: unknown; error?: unknown; result?: unknown };
  if (!body || body.jsonrpc !== "2.0" || body.id !== 1 || body.error !== undefined ||
      !Object.hasOwn(body, "result")) throw new Error(`Testnet RPC ${method} did not return a result`);
  return body.result;
}

function hex(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`${label} is not canonical hex bytes`);
  }
  return value;
}

function quantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new Error(`${label} is not a JSON-RPC quantity`);
  }
  return BigInt(value);
}

async function contractMetadata(contractId: string, address: string, minimumExpiration: bigint): Promise<void> {
  const config = networkConfigFromEnv(process.env);
  if (config.network !== "testnet") throw new Error("Customer funding is testnet-only");
  const response = await fetch(`${config.mirrorBaseUrl}/api/v1/contracts/${contractId}`, {
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Escrow contract is unavailable on testnet Mirror");
  const row = await limitedJson(response) as Record<string, unknown>;
  if (!row || row.contract_id !== contractId || row.deleted !== false ||
      typeof row.evm_address !== "string" || getAddress(row.evm_address) !== address ||
      typeof row.expiration_timestamp !== "string" ||
      !/^\d+\.\d{1,9}$/.test(row.expiration_timestamp)) {
    throw new Error("Escrow contract ID, address or expiration is not verified");
  }
  const expiry = BigInt(row.expiration_timestamp.split(".")[0]);
  if (expiry <= minimumExpiration) {
    throw new Error("Escrow contract expiration has insufficient refund buffer");
  }
}

async function escrowPreflight(verified: VerifiedSellerQuote, buyer: string): Promise<Readonly<{
  transaction: WalletTransaction; blockNumber: number; runtimeSha256: string;
}>> {
  const config = fundingConfig();
  const quote = verified.terms;
  const funding = confirmEscrowFunding(verified, buyer, verified.termsHash);
  const address = getAddress(quote.escrowAddress);
  const data = escrowInterface.encodeFunctionData("fund", [quote.sellerAddress, quote.expiresAt,
    quote.refundAfter, verified.termsHash]);
  await assertEvmRpcNetwork(networkConfigFromEnv(process.env));
  const [chain, code, latest, used, gasPriceRaw, balanceRaw] = await Promise.all([
    rpc("eth_chainId", []), rpc("eth_getCode", [address, "latest"]),
    rpc("eth_getBlockByNumber", ["latest", false]),
    rpc("eth_call", [{ to: address, data: escrowInterface.encodeFunctionData("usedTermsHash", [buyer, verified.termsHash]) }, "latest"]),
    rpc("eth_gasPrice", []), rpc("eth_getBalance", [buyer, "latest"]),
  ]);
  if (quantity(chain, "RPC chain") !== 296n) throw new Error("Funding RPC is not Hedera testnet");
  const runtime = hex(code, "contract runtime");
  if (runtime === "0x" || createHash("sha256").update(Buffer.from(runtime.slice(2), "hex")).digest("hex") !==
      config.expectedRuntimeSha256) throw new Error("Escrow runtime code does not match the approved build");
  if (!latest || typeof latest !== "object") throw new Error("Funding RPC has no latest block");
  const block = latest as { number?: unknown; timestamp?: unknown };
  const blockNumber = quantity(block.number, "latest block number");
  const blockTime = quantity(block.timestamp, "latest block time");
  if (blockNumber > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Funding block number exceeds safe integer range");
  if (blockTime + 120n >= BigInt(quote.expiresAt) || BigInt(quote.refundAfter) <= blockTime) {
    throw new CommerceIssue("Seller quote has too little time left for safe funding; ask for a fresh quote", 409);
  }
  if (BigInt(quote.refundAfter) > blockTime + 30n * 86400n) {
    throw new CommerceIssue("Seller refund deadline exceeds the testnet safety window", 409);
  }
  const usedBytes = hex(used, "terms reuse result");
  if (usedBytes.length !== 66 || escrowInterface.decodeFunctionResult("usedTermsHash", usedBytes)[0] !== false) {
    throw new Error("These seller terms were already funded or could not be checked");
  }
  await contractMetadata(quote.escrowContractId, address, BigInt(quote.refundAfter) + 7n * 86400n);
  const gasPrice = quantity(gasPriceRaw, "gas price");
  const balance = quantity(balanceRaw, "buyer balance");
  const estimate = quantity(await rpc("eth_estimateGas", [{ from: buyer, to: address,
    data, value: asQuantity(funding.valueWei) }]), "fund gas estimate");
  const gasLimit = estimate * 12n / 10n + 10_000n;
  const maxFeeWei = config.maxFeeTinybar * 10_000_000_000n;
  if (gasPrice <= 0n || gasLimit <= 0n || gasLimit > 400_000n ||
      gasPrice * gasLimit > maxFeeWei || balance < funding.valueWei + gasPrice * gasLimit) {
    throw new Error("Buyer balance, gas or transaction fee exceeds the testnet cap");
  }
  return { transaction: { from: buyer, to: address, data, value: asQuantity(funding.valueWei),
    gas: asQuantity(gasLimit), gasPrice: asQuantity(gasPrice), chainId: "0x128" },
    blockNumber: Number(blockNumber), runtimeSha256: config.expectedRuntimeSha256 };
}

export async function prepareCustomerFunding(session: CustomerSession, origin: URL,
    quoteIntentId: string): Promise<Readonly<{ funding: FundingRecord; transaction: WalletTransaction }>> {
  if (process.env.NEURON_ENABLE_CUSTOMER_APPROVAL !== "true") {
    throw new CommerceIssue("New escrow funding requires the buyer approval path to be enabled", 409);
  }
  if (!idPattern.test(quoteIntentId)) throw new CommerceIssue("Invalid reviewed quote reference", 400);
  const existing = withFundingTable(db => db.prepare(`SELECT * FROM customer_funding_intents
    WHERE quote_intent_id = ? AND owner_address = ? AND origin = ?`)
    .get(quoteIntentId, session.ownerAddress, origin.origin) as FundingRow | undefined);
  if (existing) throw new CommerceIssue("This quote already has a funding attempt; reconcile it before any new quote", 409);
  const { intent, verified } = await reverifyReviewedCommerceIntent(session, origin, quoteIntentId);
  const { transaction, blockNumber, runtimeSha256 } = await escrowPreflight(verified, session.ownerAddress);
  const now = Math.floor(Date.now() / 1000);
  if (session.expiresAt <= now || Number(verified.terms.expiresAt) <= now + 60) {
    throw new CommerceIssue("Seller quote or sign-in expired during escrow checks", 409);
  }
  return withFundingTable(db => db.transaction(() => {
    const commitTime = Math.floor(Date.now() / 1000);
    if (!currentCommerceSession(db, session, origin, commitTime) || Number(verified.terms.expiresAt) <= commitTime + 60) {
      throw new CommerceIssue("Seller quote or sign-in expired before funding preparation", 409);
    }
    const duplicate = db.prepare("SELECT id FROM customer_funding_intents WHERE quote_intent_id = ? OR terms_hash = ?")
      .get(intent.id, verified.termsHash) as { id: string } | undefined;
    if (duplicate) throw new CommerceIssue("These seller terms already have a funding attempt", 409);
    const pending = db.prepare(`SELECT id FROM customer_funding_intents WHERE owner_address = ? AND origin = ?
      AND abandoned_at IS NULL AND state IN ('prepared', 'submitted', 'failed', 'conflict') LIMIT 1`)
      .get(session.ownerAddress, origin.origin) as { id: string } | undefined;
    if (pending) throw new CommerceIssue("A previous funding attempt needs reconciliation", 409);
    const count = db.prepare("SELECT COUNT(*) AS n FROM customer_funding_intents").get() as { n: number };
    if (count.n >= 10000) throw new Error("Funding journal reached its size limit");
    const id = randomBytes(16).toString("hex");
    db.prepare(`INSERT INTO customer_funding_intents
      (id, quote_intent_id, session_id, owner_address, origin, state, contract_id,
       contract_address, seller_address, seller_account_id, seller_public_key,
       terms_hash, amount_tinybar, quote_expires_at, refund_after,
       prepared_block, scan_next_block, prepared_at, transaction_json, runtime_sha256, abi_json, updated_at)
      VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, intent.id, session.sessionId, session.ownerAddress, origin.origin,
        verified.terms.escrowContractId, verified.terms.escrowAddress, verified.terms.sellerAddress,
        verified.terms.sellerAccountId, verified.sellerPublicKey, verified.termsHash,
        verified.terms.amountTinybar, Number(verified.terms.expiresAt), Number(verified.terms.refundAfter),
        blockNumber, blockNumber, commitTime, JSON.stringify(transaction), runtimeSha256, escrowAbiJson, commitTime);
    return { funding: { id, quoteIntentId: intent.id, state: "prepared" as const, contractState: null,
      walletOpenedAt: null, runtimeSha256, abiPinned: true, abandonedAt: null,
      transactionHash: null, reportedHash: null, observedHash: null,
      escrowId: null, termsHash: verified.termsHash,
      contractId: verified.terms.escrowContractId, contractAddress: verified.terms.escrowAddress,
      sellerAccountId: verified.terms.sellerAccountId, sellerAddress: verified.terms.sellerAddress,
      amountTinybar: verified.terms.amountTinybar, quoteExpiresAt: Number(verified.terms.expiresAt),
      refundAfter: Number(verified.terms.refundAfter), preparedAt: commitTime,
      settlementHash: null, settlementMirrorTimestamp: null,
      settlementRecipientAddress: null, settlementAmountTinybar: null,
      settlementVerifiedAt: null }, transaction };
  }).immediate());
}

export async function openCustomerFundingWallet(session: CustomerSession, origin: URL,
    id: string): Promise<Readonly<{ funding: FundingRecord; transaction: WalletTransaction }>> {
  if (process.env.NEURON_ENABLE_CUSTOMER_APPROVAL !== "true") {
    throw new CommerceIssue("New escrow funding requires the buyer approval path to be enabled", 409);
  }
  if (!idPattern.test(id)) throw new CommerceIssue("Invalid funding attempt reference", 400);
  const row = fundingRow(session, origin, id);
  if (row.state !== "prepared" || row.abandoned_at !== null || row.wallet_opened_at !== null ||
      row.session_id !== session.sessionId) {
    throw new CommerceIssue("This funding attempt may already have reached a wallet; reconcile before another send", 409);
  }
  const { verified } = await reverifyReviewedCommerceIntent(session, origin, row.quote_intent_id);
  if (verified.termsHash.toLowerCase() !== row.terms_hash.toLowerCase() ||
      verified.terms.escrowContractId !== row.contract_id ||
      getAddress(verified.terms.escrowAddress) !== getAddress(row.contract_address) ||
      getAddress(verified.terms.sellerAddress) !== getAddress(row.seller_address) ||
      verified.terms.amountTinybar !== row.amount_tinybar ||
      Number(verified.terms.expiresAt) !== row.quote_expires_at ||
      Number(verified.terms.refundAfter) !== row.refund_after) {
    throw new CommerceIssue("Seller terms changed after the funding intent was recorded", 409);
  }
  const fresh = await escrowPreflight(verified, session.ownerAddress);
  if (!row.runtime_sha256 || !row.abi_json || row.abi_json !== escrowAbiJson ||
      fresh.runtimeSha256 !== row.runtime_sha256) {
    throw new CommerceIssue("The reviewed escrow runtime changed before wallet funding", 409);
  }
  const transaction = { ...fresh.transaction, nonce: await walletNonce(rpc, session.ownerAddress) };
  return withFundingTable(db => db.transaction(() => {
    const now = Math.floor(Date.now() / 1000);
    const current = db.prepare(`SELECT * FROM customer_funding_intents
      WHERE id = ? AND owner_address = ? AND origin = ?`).get(id, session.ownerAddress, origin.origin) as FundingRow | undefined;
    if (!current || current.state !== "prepared" || current.abandoned_at !== null ||
        current.wallet_opened_at !== null ||
        current.session_id !== session.sessionId || current.runtime_sha256 !== fresh.runtimeSha256 ||
        current.abi_json !== escrowAbiJson ||
        !currentCommerceSession(db, session, origin, now) || row.quote_expires_at <= now + 60) {
      throw new CommerceIssue("Funding wallet opening expired or was already attempted", 409);
    }
    const attemptId = recordWalletAttempt(db, "funding", current, transaction, now, null);
    db.prepare(`UPDATE customer_funding_intents
      SET wallet_opened_at = ?, transaction_json = ?, wallet_attempt_id = ?, updated_at = ? WHERE id = ?`)
      .run(now, JSON.stringify(transaction), attemptId, now, id);
    return { funding: asRecord({ ...current, wallet_opened_at: now, wallet_attempt_id: attemptId }), transaction };
  }).immediate());
}

export function attachCustomerFundingHash(session: CustomerSession, origin: URL,
    id: string, transactionHash: string, attemptId?: string): FundingRecord {
  if (!idPattern.test(id) || !hashPattern.test(transactionHash)) {
    throw new CommerceIssue("Invalid funding transaction reference", 400);
  }
  return withFundingTable(db => db.transaction(() => {
    const row = db.prepare(`SELECT * FROM customer_funding_intents
      WHERE id = ? AND owner_address = ? AND origin = ?`)
      .get(id, session.ownerAddress, origin.origin) as FundingRow | undefined;
    if (!row || row.abandoned_at !== null || row.wallet_opened_at === null ||
        (row.transaction_hash && row.transaction_hash.toLowerCase() !== transactionHash.toLowerCase()) ||
        (row.state !== "prepared" && row.state !== "submitted")) {
      throw new CommerceIssue("Funding attempt does not accept this transaction hash", 409);
    }
    attachWalletAttempt(db, "funding", row, transactionHash.toLowerCase(), attemptId);
    db.prepare(`UPDATE customer_funding_intents SET transaction_hash = ?, state = 'submitted', updated_at = ?
      WHERE id = ? AND state IN ('prepared', 'submitted')`)
      .run(transactionHash.toLowerCase(), Math.floor(Date.now() / 1000), id);
    return asRecord({ ...row, transaction_hash: transactionHash.toLowerCase(), state: "submitted" });
  }).immediate());
}

export function customerFundingHistory(session: CustomerSession, origin: URL, page: number): Readonly<{
  records: FundingRecord[]; hasMore: boolean;
}> {
  if (!Number.isSafeInteger(page) || page < 0 || page > 399) {
    throw new CommerceIssue("Invalid funding history page", 400);
  }
  return withFundingTable(db => {
    const rows = db.prepare(`SELECT * FROM customer_funding_intents
      WHERE owner_address = ? AND origin = ? ORDER BY prepared_at DESC, id DESC LIMIT 26 OFFSET ?`)
      .all(session.ownerAddress, origin.origin, page * 25) as FundingRow[];
    return { records: rows.slice(0, 25).map(asRecord), hasMore: rows.length > 25 };
  });
}

export function customerFundingById(session: CustomerSession, origin: URL, id: string): FundingRecord {
  if (!idPattern.test(id)) throw new CommerceIssue("Invalid funding attempt reference", 400);
  return asRecord(fundingRow(session, origin, id));
}

export function customerFundingPinnedInterface(session: CustomerSession, origin: URL, id: string): Interface {
  if (!idPattern.test(id)) throw new CommerceIssue("Invalid funding attempt reference", 400);
  return pinnedInterface(fundingRow(session, origin, id).abi_json);
}

function fundingRow(session: CustomerSession, origin: URL, id: string): FundingRow {
  const row = withFundingTable(db => db.prepare(`SELECT * FROM customer_funding_intents
    WHERE id = ? AND owner_address = ? AND origin = ?`)
    .get(id, session.ownerAddress, origin.origin) as FundingRow | undefined);
  if (!row) throw new CommerceIssue("Funding attempt is missing", 404);
  return row;
}

async function scanFunded(row: FundingRow, mode: "reconcile" | "abandon", tipOverride?: bigint):
    Promise<Readonly<{ hash: string | null; complete: boolean }>> {
  const abi = pinnedInterface(row.abi_json);
  const latest = tipOverride === undefined ?
    await rpc("eth_getBlockByNumber", ["latest", false]) as { number?: unknown } | null : null;
  const tip = tipOverride ?? quantity(latest?.number, "latest block number");
  if (tip > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Escrow log range exceeds safe block precision");
  if (tip < BigInt(row.prepared_block)) return { hash: null, complete: false };
  // A previous sweep can finish before a delayed RPC log appears. Restart at
  // the original block after every full sweep, retaining bounded page work.
  const cursor = mode === "abandon" ? row.abandon_scan_next_block ?? row.prepared_block : row.scan_next_block;
  const first = BigInt(cursor > Number(tip) ? row.prepared_block : Math.max(row.prepared_block, cursor));
  const topic = abi.getEvent("Funded")?.topicHash;
  if (!topic) throw new Error("Funded event ABI is unavailable");
  for (let start = first, page = 0; start <= tip && page < 5; start += 1000n, page++) {
    const end = start + 999n < tip ? start + 999n : tip;
    const logs = await rpc("eth_getLogs", [{ address: row.contract_address,
      fromBlock: asQuantity(start), toBlock: asQuantity(end),
      topics: [topic, null, zeroPadValue(row.owner_address, 32), row.terms_hash] }]) as unknown;
    if (!Array.isArray(logs) || logs.length > 1000) throw new Error("Escrow log search was malformed or oversized");
    for (const log of logs) {
      if (!log || typeof log !== "object") throw new Error("Escrow log was malformed");
      const entry = log as { address?: unknown; topics?: unknown; data?: unknown; transactionHash?: unknown };
      if (typeof entry.address !== "string" || getAddress(entry.address) !== getAddress(row.contract_address) ||
          !Array.isArray(entry.topics) || typeof entry.data !== "string" ||
          typeof entry.transactionHash !== "string" || !hashPattern.test(entry.transactionHash)) {
        throw new Error("Escrow log identity was malformed");
      }
      const parsed = abi.parseLog({ topics: entry.topics as string[], data: entry.data });
      if (parsed?.name === "Funded" && getAddress(parsed.args.buyer) === row.owner_address &&
          parsed.args.termsHash.toLowerCase() === row.terms_hash.toLowerCase() &&
          getAddress(parsed.args.seller) === row.seller_address &&
          parsed.args.amount === BigInt(row.amount_tinybar) &&
          parsed.args.quoteExpiresAt === BigInt(row.quote_expires_at) &&
          parsed.args.refundAfter === BigInt(row.refund_after)) {
        return { hash: entry.transactionHash.toLowerCase(), complete: false };
      }
    }
    const next = end === tip ? BigInt(row.prepared_block) : end + 1n;
    const column = mode === "abandon" ? "abandon_scan_next_block" : "scan_next_block";
    withFundingTable(db => db.prepare(`UPDATE customer_funding_intents
      SET ${column} = ?, updated_at = ? WHERE id = ?`)
      .run(Number(next), Math.floor(Date.now() / 1000), row.id));
    if (end === tip) return { hash: null, complete: true };
  }
  return { hash: null, complete: false };
}

async function escrowState(row: FundingRow, id: bigint, blockTag = "latest"): Promise<ContractState> {
  const abi = pinnedInterface(row.abi_json);
  const result = hex(await rpc("eth_call", [{ to: row.contract_address,
    data: abi.encodeFunctionData("escrows", [id]) }, blockTag]), "escrow state");
  const item = abi.decodeFunctionResult("escrows", result);
  if (getAddress(item.buyer) !== row.owner_address || getAddress(item.seller) !== row.seller_address ||
      BigInt(item.amount) !== BigInt(row.amount_tinybar) ||
      BigInt(item.quoteExpiresAt) !== BigInt(row.quote_expires_at) ||
      BigInt(item.refundAfter) !== BigInt(row.refund_after) ||
      String(item.termsHash).toLowerCase() !== row.terms_hash.toLowerCase()) {
    throw new Error("Escrow storage does not match the seller quote");
  }
  const states: Record<string, ContractState> = { "1": "funded", "2": "approved", "3": "paid", "4": "refunded" };
  const state = states[String(item.state)];
  if (!state) throw new Error("Escrow storage has an unsupported state");
  return state;
}

async function scanReleased(row: FundingRow): Promise<string | null> {
  if (!row.escrow_id || !row.confirmed_hash) throw new Error("Paid escrow has no confirmed funding");
  const config = networkConfigFromEnv(process.env);
  if (config.network !== "testnet") throw new Error("Settlement discovery is testnet-only");
  const abi = pinnedInterface(row.abi_json);
  const fundingResponse = await fetch(`${config.mirrorBaseUrl}/api/v1/contracts/results/${row.confirmed_hash}`, {
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (fundingResponse.status === 404) return null;
  if (!fundingResponse.ok) throw new Error("Mirror funded escrow result is unavailable");
  const funded = await limitedJson(fundingResponse) as Record<string, unknown>;
  if (!funded || funded.hash !== row.confirmed_hash || funded.contract_id !== row.contract_id ||
      funded.result !== "SUCCESS" || typeof funded.timestamp !== "string" ||
      !/^\d+\.\d{9}$/.test(funded.timestamp) ||
      BigInt(funded.timestamp.split(".")[0]) >= BigInt(row.refund_after)) {
    throw new Error("Mirror funding result cannot bound the seller withdrawal search");
  }
  const topic = abi.getEvent("Released")?.topicHash;
  if (!topic) throw new Error("Pinned escrow ABI has no Released event");
  const query = new URLSearchParams({ topic0: topic,
    topic1: topicUint(BigInt(row.escrow_id)), topic2: zeroPadValue(row.seller_address, 32),
    limit: "100", order: "desc" });
  query.append("timestamp", `gte:${funded.timestamp}`);
  query.append("timestamp", `lte:${row.refund_after}.999999999`);
  const response = await fetch(`${config.mirrorBaseUrl}/api/v1/contracts/${row.contract_id}/results/logs?${query}`, {
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Mirror seller withdrawal log search is unavailable");
  const page = await limitedJson(response, 262_144) as Record<string, unknown>;
  if (!page || !Array.isArray(page.logs) || page.logs.length > 100 ||
      !page.links || typeof page.links !== "object" ||
      (page.links as { next?: unknown }).next !== null) {
    throw new Error("Mirror seller withdrawal log search is incomplete");
  }
  if (page.logs.length === 0) return null;
  if (page.logs.length !== 1) throw new Error("Multiple seller withdrawal logs found for one escrow");
  const log = page.logs[0] as { address?: unknown; contract_id?: unknown; topics?: unknown;
    data?: unknown; transaction_hash?: unknown; timestamp?: unknown };
  if (!log || log.contract_id !== row.contract_id || typeof log.address !== "string" ||
      getAddress(log.address) !== getAddress(row.contract_address) || !Array.isArray(log.topics) ||
      typeof log.data !== "string" || typeof log.transaction_hash !== "string" ||
      !hashPattern.test(log.transaction_hash) || typeof log.timestamp !== "string" ||
      !/^\d+\.\d{9}$/.test(log.timestamp) ||
      BigInt(log.timestamp.replace(".", "")) < BigInt(funded.timestamp.replace(".", "")) ||
      BigInt(log.timestamp.split(".")[0]) >= BigInt(row.refund_after)) {
    throw new Error("Mirror Released log identity is malformed");
  }
  const event = abi.parseLog({ topics: log.topics as string[], data: log.data });
  if (event?.name !== "Released" || BigInt(event.args.id) !== BigInt(row.escrow_id) ||
      getAddress(event.args.seller) !== row.seller_address ||
      getAddress(event.args.to) !== row.seller_address ||
      BigInt(event.args.amount) !== BigInt(row.amount_tinybar)) {
    throw new Error("Mirror Released log conflicts with the funded seller and amount");
  }
  return log.transaction_hash.toLowerCase();
}

async function reconcileCustomerSettlement(session: CustomerSession, origin: URL,
    id: string): Promise<FundingRecord> {
  const row = fundingRow(session, origin, id);
  if (row.state !== "executed" || row.contract_state !== "paid" || !row.escrow_id ||
      !row.confirmed_hash || !row.runtime_sha256 || !row.seller_account_id || !row.seller_public_key) {
    throw new Error("Settlement requires a confirmed funded escrow in Paid storage state");
  }
  const abi = pinnedInterface(row.abi_json);
  const code = hex(await rpc("eth_getCode", [row.contract_address, "latest"]), "settlement contract runtime");
  if (code === "0x" || createHash("sha256").update(Buffer.from(code.slice(2), "hex")).digest("hex") !==
      row.runtime_sha256) throw new Error("Paid escrow runtime differs from its funded build");
  const hash = row.settlement_hash ?? await scanReleased(row);
  if (!hash) return asRecord(fundingRow(session, origin, id));
  const [tx, receipt] = await Promise.all([
    rpc("eth_getTransactionByHash", [hash]), rpc("eth_getTransactionReceipt", [hash]),
  ]) as [Record<string, unknown> | null, Record<string, unknown> | null];
  if (!tx || !receipt) return asRecord(fundingRow(session, origin, id));
  if (typeof tx.hash !== "string" || tx.hash.toLowerCase() !== hash ||
      typeof tx.from !== "string" || getAddress(tx.from) !== row.seller_address ||
      typeof tx.to !== "string" || getAddress(tx.to) !== getAddress(row.contract_address) ||
      typeof tx.input !== "string" || tx.input.toLowerCase() !==
        abi.encodeFunctionData("withdraw", [BigInt(row.escrow_id)]).toLowerCase() ||
      quantity(tx.value, "seller withdrawal transaction value") !== 0n ||
      quantity(receipt.status, "seller withdrawal receipt status") !== 1n ||
      typeof receipt.transactionHash !== "string" || receipt.transactionHash.toLowerCase() !== hash) {
    throw new Error("Seller withdrawal transaction or receipt does not match the escrow");
  }
  if (!Array.isArray(receipt.logs)) throw new Error("Seller withdrawal receipt has no logs");
  const released = receipt.logs.flatMap(value => {
    if (!value || typeof value !== "object") return [];
    const log = value as { address?: unknown; topics?: unknown; data?: unknown };
    if (typeof log.address !== "string" || getAddress(log.address) !== getAddress(row.contract_address) ||
        !Array.isArray(log.topics) || typeof log.data !== "string") return [];
    try {
      const event = abi.parseLog({ topics: log.topics as string[], data: log.data });
      return event?.name === "Released" ? [event] : [];
    } catch { return []; }
  });
  if (released.length !== 1 || BigInt(released[0].args.id) !== BigInt(row.escrow_id) ||
      getAddress(released[0].args.seller) !== row.seller_address ||
      getAddress(released[0].args.to) !== row.seller_address ||
      BigInt(released[0].args.amount) !== BigInt(row.amount_tinybar)) {
    throw new Error("Withdrawal receipt lacks the exact seller Released event");
  }
  const config = networkConfigFromEnv(process.env);
  if (config.network !== "testnet") throw new Error("Settlement reconciliation is testnet-only");
  const base = `${config.mirrorBaseUrl}/api/v1/contracts/results/${hash}`;
  const [resultResponse, actionsResponse, sellerResponse] = await Promise.all([
    fetch(base, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) }),
    fetch(`${base}/actions?limit=100`, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) }),
    fetch(`${config.mirrorBaseUrl}/api/v1/accounts/${row.seller_address}`, {
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) }),
  ]);
  if ([resultResponse, actionsResponse, sellerResponse].some(response => response.status === 404)) {
    return asRecord(fundingRow(session, origin, id));
  }
  if (!resultResponse.ok || !actionsResponse.ok || !sellerResponse.ok) {
    throw new Error("Independent Mirror settlement evidence is unavailable");
  }
  const [mirror, actionPage, seller] = await Promise.all([
    limitedJson(resultResponse), limitedJson(actionsResponse, 262_144), limitedJson(sellerResponse),
  ]) as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
  if (!mirror || mirror.hash !== hash || mirror.contract_id !== row.contract_id ||
      mirror.result !== "SUCCESS" || typeof mirror.timestamp !== "string" ||
      !/^\d+\.\d{9}$/.test(mirror.timestamp) || !Array.isArray(mirror.logs) ||
      !seller || seller.deleted !== false || seller.account !== row.seller_account_id ||
      typeof seller.evm_address !== "string" || getAddress(seller.evm_address) !== row.seller_address) {
    throw new Error("Mirror result or seller account does not match the funded escrow");
  }
  const sellerKey = seller.key as { _type?: unknown; key?: unknown } | null;
  if (!sellerKey || sellerKey._type !== "ECDSA_SECP256K1" ||
      typeof sellerKey.key !== "string" ||
      sellerKey.key.toLowerCase() !== row.seller_public_key.toLowerCase() ||
      computeAddress(`0x${sellerKey.key}`) !== row.seller_address) {
    throw new Error("Seller account key or EVM alias differs from the signed quote");
  }
  const mirrorReleased = mirror.logs.flatMap(value => {
    if (!value || typeof value !== "object") return [];
    const log = value as { address?: unknown; topics?: unknown; data?: unknown; contract_id?: unknown };
    if (log.contract_id !== row.contract_id || typeof log.address !== "string" ||
        getAddress(log.address) !== getAddress(row.contract_address) ||
        !Array.isArray(log.topics) || typeof log.data !== "string") return [];
    try {
      const event = abi.parseLog({ topics: log.topics as string[], data: log.data });
      return event?.name === "Released" ? [event] : [];
    } catch { return []; }
  });
  if (mirrorReleased.length !== 1 || BigInt(mirrorReleased[0].args.id) !== BigInt(row.escrow_id) ||
      getAddress(mirrorReleased[0].args.seller) !== row.seller_address ||
      getAddress(mirrorReleased[0].args.to) !== row.seller_address ||
      BigInt(mirrorReleased[0].args.amount) !== BigInt(row.amount_tinybar)) {
    throw new Error("Mirror result lacks the exact seller Released event");
  }
  if (!actionPage || !Array.isArray(actionPage.actions) || actionPage.actions.length > 100 ||
      !actionPage.links || typeof actionPage.links !== "object" ||
      (actionPage.links as { next?: unknown }).next !== null) {
    throw new Error("Mirror seller transfer actions are incomplete");
  }
  const positiveActions = actionPage.actions.filter(value => {
    if (!value || typeof value !== "object") throw new Error("Mirror seller transfer action is malformed");
    const action = value as { value?: unknown };
    if (!Number.isSafeInteger(action.value) || Number(action.value) < 0) {
      throw new Error("Mirror seller transfer value is not a safe tinybar integer");
    }
    return Number(action.value) > 0;
  }) as Record<string, unknown>[];
  const payout = positiveActions[0];
  // Mirror contract-action values use tinybar; the JSON-RPC transaction value
  // above uses weibars. The quote cap is 1 HBAR, so this JSON integer is exact.
  if (positiveActions.length !== 1 || !payout || payout.call_depth !== 1 ||
      payout.call_operation_type !== "CALL" || payout.call_type !== "CALL" ||
      payout.result_data_type !== "OUTPUT" || payout.caller_type !== "CONTRACT" ||
      payout.caller !== row.contract_id || payout.recipient_type !== "ACCOUNT" ||
      payout.recipient !== seller.account || payout.timestamp !== mirror.timestamp ||
      BigInt(payout.value as number) !== BigInt(row.amount_tinybar)) {
    throw new Error("Mirror actions do not show the exact native HBAR transfer to the seller");
  }
  if (await escrowState(row, BigInt(row.escrow_id)) !== "paid") {
    throw new Error("Escrow storage no longer reports a completed seller withdrawal");
  }
  return withFundingTable(db => db.transaction(() => {
    const current = db.prepare("SELECT * FROM customer_funding_intents WHERE id = ?")
      .get(id) as FundingRow | undefined;
    if (!current || current.state !== "executed" || current.contract_state !== "paid" ||
        current.escrow_id !== row.escrow_id || current.confirmed_hash !== row.confirmed_hash ||
        (current.settlement_hash && current.settlement_hash !== hash) ||
        (current.settlement_mirror_timestamp && current.settlement_mirror_timestamp !== mirror.timestamp) ||
        (current.settlement_recipient_address && current.settlement_recipient_address !== row.seller_address) ||
        (current.settlement_amount_tinybar && current.settlement_amount_tinybar !== row.amount_tinybar)) {
      throw new Error("Settlement evidence conflicts with the durable funding journal");
    }
    db.prepare(`UPDATE customer_funding_intents SET settlement_hash = ?, settlement_mirror_timestamp = ?,
      settlement_recipient_address = ?, settlement_amount_tinybar = ?,
      settlement_verified_at = COALESCE(settlement_verified_at, ?), updated_at = ? WHERE id = ?`)
      .run(hash, mirror.timestamp, row.seller_address, row.amount_tinybar,
        Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), id);
    return asRecord(db.prepare("SELECT * FROM customer_funding_intents WHERE id = ?").get(id) as FundingRow);
  }).immediate());
}

export async function reconcileCustomerFunding(session: CustomerSession, origin: URL,
    id: string): Promise<FundingRecord> {
  if (!idPattern.test(id)) throw new CommerceIssue("Invalid funding attempt reference", 400);
  const row = fundingRow(session, origin, id);
  const abi = pinnedInterface(row.abi_json);
  await assertEvmRpcNetwork(networkConfigFromEnv(process.env));
  // Always search the indexed seller-terms event while unresolved. A browser
  // can report a wrong hash, and a crash can occur after wallet broadcast but
  // before the hash reaches this journal.
  if (row.abandoned_at !== null) return asRecord(row);
  const eventHash = row.state === "executed" && row.confirmed_hash ? row.confirmed_hash :
    (await scanFunded(row, "reconcile")).hash;
  if (eventHash) {
    withFundingTable(db => db.transaction(() => {
      const current = db.prepare("SELECT observed_hash, transaction_hash FROM customer_funding_intents WHERE id = ?")
        .get(id) as { observed_hash: string | null; transaction_hash: string | null } | undefined;
      if (!current || (current.observed_hash && current.observed_hash !== eventHash)) {
        throw new Error("Funding event conflicts with the durable journal");
      }
      db.prepare(`UPDATE customer_funding_intents SET observed_hash = ?,
        state = CASE WHEN transaction_hash IS NOT NULL AND transaction_hash != ? AND state != 'executed'
          THEN 'conflict' ELSE state END, updated_at = ? WHERE id = ?`)
        .run(eventHash, eventHash, Math.floor(Date.now() / 1000), id);
    }).immediate());
  }
  const hash = eventHash ?? row.confirmed_hash ?? row.observed_hash ?? row.transaction_hash;
  if (!hash) return asRecord(fundingRow(session, origin, id));
  function mark(state: "failed" | "conflict"): FundingRecord {
    return withFundingTable(db => {
      db.prepare(`UPDATE customer_funding_intents SET state = ?, updated_at = ?
        WHERE id = ? AND state != 'executed'`).run(state, Math.floor(Date.now() / 1000), id);
      return asRecord(db.prepare("SELECT * FROM customer_funding_intents WHERE id = ?").get(id) as FundingRow);
    });
  }
  const tx = await rpc("eth_getTransactionByHash", [hash]) as Record<string, unknown> | null;
  const receipt = await rpc("eth_getTransactionReceipt", [hash]) as Record<string, unknown> | null;
  if (!tx || !receipt) return asRecord(fundingRow(session, origin, id));
  const intended = JSON.parse(row.transaction_json) as WalletTransaction;
  if (typeof tx.from !== "string" || getAddress(tx.from) !== row.owner_address ||
      typeof tx.to !== "string" || getAddress(tx.to) !== getAddress(row.contract_address) ||
      typeof tx.input !== "string" || tx.input.toLowerCase() !== intended.data.toLowerCase() ||
      quantity(tx.value, "transaction value") !== quantity(intended.value, "intended value") ||
      String(tx.hash).toLowerCase() !== hash.toLowerCase()) {
    return mark("conflict");
  }
  const status = quantity(receipt.status, "transaction receipt status");
  const config = networkConfigFromEnv(process.env);
  if (config.network !== "testnet") throw new Error("Funding reconciliation is testnet-only");
  const mirrorResponse = await fetch(`${config.mirrorBaseUrl}/api/v1/contracts/results/${hash}`, {
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" } });
  if (mirrorResponse.status === 404) return asRecord(fundingRow(session, origin, id));
  if (!mirrorResponse.ok) throw new Error("Mirror contract receipt is unavailable");
  const mirror = await limitedJson(mirrorResponse) as Record<string, unknown>;
  if (!mirror || mirror.contract_id !== row.contract_id) {
    throw new Error("Mirror contract ID does not match the funding intent");
  }
  assertRefundReceiptHashes(hash, receipt.transactionHash, mirror.hash);
  if (status !== 1n || mirror.result !== "SUCCESS") {
    if (status === 0n && typeof mirror.result === "string" && /^[A-Z][A-Z0-9_]+$/.test(mirror.result) &&
        !["SUCCESS", "UNKNOWN", "PENDING"].includes(mirror.result)) {
      return mark(eventHash ? "conflict" : "failed");
    }
    throw new Error("RPC and Mirror disagree about escrow funding");
  }
  const logs = receipt.logs;
  if (!Array.isArray(logs)) throw new Error("Funding receipt has no logs");
  const funded = logs.flatMap(value => {
    if (!value || typeof value !== "object") return [];
    const log = value as { address?: unknown; topics?: unknown; data?: unknown };
    if (typeof log.address !== "string" || getAddress(log.address) !== getAddress(row.contract_address) ||
        !Array.isArray(log.topics) || typeof log.data !== "string") return [];
    try {
      const event = abi.parseLog({ topics: log.topics as string[], data: log.data });
      return event?.name === "Funded" ? [event] : [];
    } catch { return []; }
  });
  if (funded.length !== 1) throw new Error("Funding receipt did not emit exactly one escrow Funded event");
  const event = funded[0].args;
  if (getAddress(event.buyer) !== row.owner_address || getAddress(event.seller) !== row.seller_address ||
      BigInt(event.amount) !== BigInt(row.amount_tinybar) ||
      BigInt(event.quoteExpiresAt) !== BigInt(row.quote_expires_at) ||
      BigInt(event.refundAfter) !== BigInt(row.refund_after) ||
      String(event.termsHash).toLowerCase() !== row.terms_hash.toLowerCase()) {
    throw new Error("Funded event does not match the reviewed seller terms");
  }
  const escrowId = BigInt(event.id);
  if (escrowId <= 0n) throw new Error("Funded event has an invalid escrow ID");
  const state = await escrowState(row, escrowId);
  const confirmed = withFundingTable(db => db.transaction(() => {
    const current = db.prepare("SELECT confirmed_hash, escrow_id FROM customer_funding_intents WHERE id = ?")
      .get(id) as { confirmed_hash: string | null; escrow_id: string | null } | undefined;
    if (!current || (current.confirmed_hash && current.confirmed_hash.toLowerCase() !== hash.toLowerCase()) ||
        (current.escrow_id && current.escrow_id !== String(escrowId))) {
      throw new Error("Funding journal changed while reconciling");
    }
    db.prepare(`UPDATE customer_funding_intents SET state = 'executed', contract_state = ?,
      confirmed_hash = ?, escrow_id = ?, updated_at = ? WHERE id = ?`)
      .run(state, hash.toLowerCase(), String(escrowId), Math.floor(Date.now() / 1000), id);
    const updated = db.prepare("SELECT * FROM customer_funding_intents WHERE id = ?")
      .get(id) as FundingRow;
    return asRecord(updated);
  }).immediate());
  return confirmed.contractState === "paid" ?
    reconcileCustomerSettlement(session, origin, id) : confirmed;
}

export async function resolveExpiredCustomerFunding(session: CustomerSession, origin: URL,
    id: string): Promise<Readonly<{ funding: FundingRecord; scanComplete: boolean }>> {
  if (!idPattern.test(id)) throw new CommerceIssue("Invalid funding attempt reference", 400);
  let row = fundingRow(session, origin, id);
  if (row.state === "failed") {
    const checked = await reconcileCustomerFunding(session, origin, id);
    if (checked.state !== "failed") throw new CommerceIssue("Reconcile the original funding before expiry recovery", 409);
    row = fundingRow(session, origin, id);
  }
  if (row.abandoned_at !== null) return { funding: asRecord(row), scanComplete: true };
  if (!((row.state === "prepared" && !row.transaction_hash) || (row.state === "failed" && row.transaction_hash)) ||
      row.observed_hash || row.confirmed_hash || !row.runtime_sha256 || !/^[0-9a-f]{64}$/.test(row.runtime_sha256)) {
    throw new CommerceIssue("Only an unhashed prepared quote or definitively failed funding can be resolved as expired", 409);
  }
  const abi = pinnedInterface(row.abi_json);
  await assertEvmRpcNetwork(networkConfigFromEnv(process.env));
  const latest = await rpc("eth_getBlockByNumber", ["latest", false]) as { number?: unknown; timestamp?: unknown } | null;
  const tip = quantity(latest?.number, "expiry proof block number");
  const blockTime = quantity(latest?.timestamp, "expiry proof block time");
  if (tip > BigInt(Number.MAX_SAFE_INTEGER) || blockTime <= BigInt(row.quote_expires_at)) {
    throw new CommerceIssue("The on-chain quote expiry has not passed", 409);
  }
  const address = getAddress(row.contract_address);
  const blockTag = asQuantity(tip);
  const [code, used] = await Promise.all([
    rpc("eth_getCode", [address, blockTag]),
    rpc("eth_call", [{ to: address,
      data: abi.encodeFunctionData("usedTermsHash", [row.owner_address, row.terms_hash]) }, blockTag]),
  ]);
  const runtime = hex(code, "original escrow runtime");
  if (runtime === "0x" || createHash("sha256").update(Buffer.from(runtime.slice(2), "hex")).digest("hex") !==
      row.runtime_sha256) throw new Error("Expired quote escrow runtime differs from its pinned build");
  await contractMetadata(row.contract_id, address, 0n);
  const usedBytes = hex(used, "expired quote terms result");
  if (usedBytes.length !== 66 || abi.decodeFunctionResult("usedTermsHash", usedBytes)[0] !== false) {
    throw new CommerceIssue("The buyer's terms hash is used or could not be proven unused", 409);
  }
  const scan = await scanFunded(row, "abandon", tip);
  if (scan.hash) {
    throw new CommerceIssue("A matching Funded event exists; reconcile the original funding", 409);
  }
  if (!scan.complete) return { funding: asRecord(fundingRow(session, origin, id)), scanComplete: false };
  // A successful fund before this post-expiry block would have set the replay
  // mapping. The contract's quote-expiry guard prevents a later success.
  const funding = withFundingTable(db => db.transaction(() => {
    const current = db.prepare(`SELECT * FROM customer_funding_intents
      WHERE id = ? AND owner_address = ? AND origin = ?`).get(id, session.ownerAddress, origin.origin) as FundingRow | undefined;
    if (!current || current.state !== row.state || current.abandoned_at !== null ||
        current.transaction_hash !== row.transaction_hash || current.observed_hash || current.confirmed_hash ||
        !currentCommerceSession(db, session, origin, Math.floor(Date.now() / 1000)) ||
        current.runtime_sha256 !== row.runtime_sha256 || current.abi_json !== row.abi_json) {
      throw new CommerceIssue("Funding journal changed while resolving the expired quote", 409);
    }
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`UPDATE customer_funding_intents SET abandoned_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, id);
    return asRecord({ ...current, abandoned_at: now });
  }).immediate());
  return { funding, scanComplete: true };
}

function refundRow(session: CustomerSession, origin: URL, id: string): RefundRow {
  const row = withRefundTable(db => db.prepare(`SELECT * FROM customer_refund_intents
    WHERE id = ? AND owner_address = ? AND origin = ?`)
    .get(id, session.ownerAddress, origin.origin) as RefundRow | undefined);
  if (!row) throw new CommerceIssue("Refund attempt is missing", 404);
  return row;
}

export function latestCustomerRefund(session: CustomerSession, origin: URL): RefundRecord | null {
  return withRefundTable(db => {
    const row = db.prepare(`SELECT * FROM customer_refund_intents
      WHERE owner_address = ? AND origin = ? ORDER BY prepared_at DESC LIMIT 1`)
      .get(session.ownerAddress, origin.origin) as RefundRow | undefined;
    return row ? asRefund(row) : null;
  });
}

export function customerRefundForFunding(session: CustomerSession, origin: URL, fundingId: string): RefundRecord | null {
  if (!idPattern.test(fundingId)) throw new CommerceIssue("Invalid funded escrow reference", 400);
  return withRefundTable(db => {
    const row = db.prepare(`SELECT * FROM customer_refund_intents
      WHERE funding_id = ? AND owner_address = ? AND origin = ?`)
      .get(fundingId, session.ownerAddress, origin.origin) as RefundRow | undefined;
    return row ? asRefund(row) : null;
  });
}

async function refundPreflight(session: CustomerSession, origin: URL,
    fundingId: string): Promise<Readonly<{ funding: FundingRow; escrowId: string;
      transaction: WalletTransaction; blockNumber: number }>> {
  if (!idPattern.test(fundingId)) throw new CommerceIssue("Invalid funded escrow reference", 400);
  const confirmed = await reconcileCustomerFunding(session, origin, fundingId);
  if (confirmed.state !== "executed" || !confirmed.escrowId ||
      (confirmed.contractState !== "funded" && confirmed.contractState !== "approved")) {
    throw new CommerceIssue("An active funded escrow is required for buyer refund", 409);
  }
  const funding = fundingRow(session, origin, fundingId);
  const maxFeeTinybar = feeCapTinybar();
  if (!funding.runtime_sha256 || !/^[0-9a-f]{64}$/.test(funding.runtime_sha256)) {
    throw new CommerceIssue("Original funded escrow runtime was not pinned; refund needs operator review", 409);
  }
  const abi = pinnedInterface(funding.abi_json);
  await assertEvmRpcNetwork(networkConfigFromEnv(process.env));
  const address = getAddress(funding.contract_address);
  const data = abi.encodeFunctionData("refund", [BigInt(confirmed.escrowId)]);
  const [code, latest, gasPriceRaw, balanceRaw] = await Promise.all([
    rpc("eth_getCode", [address, "latest"]), rpc("eth_getBlockByNumber", ["latest", false]),
    rpc("eth_gasPrice", []), rpc("eth_getBalance", [session.ownerAddress, "latest"]),
  ]);
  const runtime = hex(code, "refund contract runtime");
  if (runtime === "0x" || createHash("sha256").update(Buffer.from(runtime.slice(2), "hex")).digest("hex") !==
      funding.runtime_sha256) throw new Error("Refund contract code differs from the originally funded build");
  if (!latest || typeof latest !== "object") throw new Error("Refund RPC has no latest block");
  const block = latest as { number?: unknown; timestamp?: unknown };
  const blockNumber = quantity(block.number, "refund block number");
  const blockTime = quantity(block.timestamp, "refund block time");
  if (blockNumber > BigInt(Number.MAX_SAFE_INTEGER) || blockTime < BigInt(funding.refund_after)) {
    throw new CommerceIssue("Escrow refund deadline has not arrived", 409);
  }
  // A due refund must remain possible near the contract's renewal boundary;
  // retain only a short execution buffer, unlike the pre-funding 7-day buffer.
  await contractMetadata(funding.contract_id, address, blockTime + 120n);
  if (!(["funded", "approved"] as ContractState[]).includes(await escrowState(funding, BigInt(confirmed.escrowId)))) {
    throw new CommerceIssue("Escrow is no longer refundable", 409);
  }
  const gasPrice = quantity(gasPriceRaw, "refund gas price");
  const estimate = quantity(await rpc("eth_estimateGas", [{ from: session.ownerAddress,
    to: address, data, value: "0x0" }]), "refund gas estimate");
  const gasLimit = estimate * 12n / 10n + 10_000n;
  const balance = quantity(balanceRaw, "buyer refund gas balance");
  if (gasPrice <= 0n || gasLimit <= 0n || gasLimit > 250_000n ||
      gasLimit * gasPrice > maxFeeTinybar * 10_000_000_000n || balance < gasLimit * gasPrice) {
    throw new Error("Buyer refund gas or fee exceeds the configured cap");
  }
  const transaction: WalletTransaction = { from: session.ownerAddress, to: address, value: "0x0", data,
    gas: asQuantity(gasLimit), gasPrice: asQuantity(gasPrice), chainId: "0x128" };
  return { funding, escrowId: confirmed.escrowId, transaction, blockNumber: Number(blockNumber) };
}

export async function prepareCustomerRefund(session: CustomerSession, origin: URL,
    fundingId: string): Promise<Readonly<{ refund: RefundRecord; transaction: WalletTransaction }>> {
  const previous = withRefundTable(db => db.prepare("SELECT id FROM customer_refund_intents WHERE funding_id = ?")
    .get(fundingId) as { id: string } | undefined);
  if (previous) throw new CommerceIssue("This escrow already has a refund attempt", 409);
  const { funding, escrowId, transaction, blockNumber } = await refundPreflight(session, origin, fundingId);
  return withRefundTable(db => db.transaction(() => {
    const commitTime = Math.floor(Date.now() / 1000);
    if (!currentCommerceSession(db, session, origin, commitTime)) throw new CommerceIssue("Sign in again before refunding", 401);
    const duplicate = db.prepare("SELECT id FROM customer_refund_intents WHERE funding_id = ?")
      .get(fundingId) as { id: string } | undefined;
    if (duplicate) throw new CommerceIssue("This escrow already has a refund attempt", 409);
    const id = randomBytes(16).toString("hex");
    db.prepare(`INSERT INTO customer_refund_intents
      (id, funding_id, session_id, owner_address, origin, state, escrow_id, contract_id,
       contract_address, amount_tinybar, prepared_block, scan_next_block, prepared_at,
       transaction_json, abi_json, updated_at)
      VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, fundingId, session.sessionId, session.ownerAddress, origin.origin,
        escrowId, funding.contract_id, funding.contract_address, funding.amount_tinybar,
        blockNumber, blockNumber, commitTime, JSON.stringify(transaction), funding.abi_json, commitTime);
    return { refund: { id, fundingId, state: "prepared" as const, escrowId,
      walletOpenedAt: null, walletOpenCount: 0,
      transactionHash: null, reportedHash: null, observedHash: null,
      amountTinybar: funding.amount_tinybar, preparedAt: commitTime }, transaction };
  }).immediate());
}

export async function openCustomerRefundWallet(session: CustomerSession, origin: URL,
    id: string): Promise<Readonly<{ refund: RefundRecord; transaction: WalletTransaction }>> {
  if (!idPattern.test(id)) throw new CommerceIssue("Invalid refund attempt reference", 400);
  const row = refundRow(session, origin, id);
  // A refund may become due after the original short-lived customer session
  // expires. The newly authenticated same buyer may resume an unopened intent.
  if (row.state !== "prepared" || row.wallet_opened_at !== null) {
    throw new CommerceIssue("This refund may already have reached a wallet; reconcile before another send", 409);
  }
  const fresh = await refundPreflight(session, origin, row.funding_id);
  if (fresh.escrowId !== row.escrow_id || fresh.funding.contract_id !== row.contract_id ||
      getAddress(fresh.funding.contract_address) !== getAddress(row.contract_address) ||
      fresh.funding.amount_tinybar !== row.amount_tinybar || fresh.funding.abi_json !== row.abi_json) {
    throw new CommerceIssue("Funded escrow changed before refund wallet opening", 409);
  }
  const transaction = { ...fresh.transaction, nonce: await walletNonce(rpc, session.ownerAddress) };
  return withRefundTable(db => db.transaction(() => {
    const now = Math.floor(Date.now() / 1000);
    const current = db.prepare(`SELECT * FROM customer_refund_intents
      WHERE id = ? AND owner_address = ? AND origin = ?`).get(id, session.ownerAddress, origin.origin) as RefundRow | undefined;
    if (!current || current.state !== "prepared" || current.wallet_opened_at !== null ||
        current.wallet_open_count !== 0 ||
        current.abi_json !== fresh.funding.abi_json ||
        !currentCommerceSession(db, session, origin, now)) {
      throw new CommerceIssue("Refund wallet opening expired or was already attempted", 409);
    }
    const attemptId = recordWalletAttempt(db, "refund", current, transaction, now, null);
    db.prepare(`UPDATE customer_refund_intents
      SET wallet_opened_at = ?, wallet_open_count = 1, transaction_json = ?, wallet_attempt_id = ?, updated_at = ? WHERE id = ?`)
      .run(now, JSON.stringify(transaction), attemptId, now, id);
    return { refund: asRefund({ ...current, wallet_opened_at: now, wallet_open_count: 1, wallet_attempt_id: attemptId }),
      transaction };
  }).immediate());
}

export async function retryCustomerRefundWallet(session: CustomerSession, origin: URL,
    id: string): Promise<Readonly<{ refund: RefundRecord; transaction: WalletTransaction; warning: string }>> {
  if (!idPattern.test(id)) throw new CommerceIssue("Invalid refund attempt reference", 400);
  const initial = refundRow(session, origin, id);
  if (initial.wallet_opened_at === null || !["prepared", "submitted", "failed"].includes(initial.state) ||
      (initial.state !== "failed" && initial.wallet_opened_at > Math.floor(Date.now() / 1000) - 60)) {
    throw new CommerceIssue("Reconcile the refund and wait one minute after an uncertain wallet opening before retrying", 409);
  }
  await reconcileCustomerRefund(session, origin, id);
  const row = refundRow(session, origin, id);
  const now = Math.floor(Date.now() / 1000);
  if (!["prepared", "submitted", "failed"].includes(row.state) || row.observed_hash || row.confirmed_hash ||
      row.wallet_opened_at === null || (row.state !== "failed" && row.wallet_opened_at > now - 60)) {
    throw new CommerceIssue("Reconcile the refund and wait one minute after an uncertain wallet opening before retrying", 409);
  }
  const fresh = await refundPreflight(session, origin, row.funding_id);
  if (fresh.escrowId !== row.escrow_id || fresh.funding.contract_id !== row.contract_id ||
      getAddress(fresh.funding.contract_address) !== getAddress(row.contract_address) ||
      fresh.funding.amount_tinybar !== row.amount_tinybar || fresh.funding.abi_json !== row.abi_json) {
    throw new CommerceIssue("Funded escrow changed before the refund retry", 409);
  }
  const transaction = { ...fresh.transaction,
    nonce: await walletNonce(rpc, session.ownerAddress, row.transaction_json, row.state === "failed", async blockTag => {
      const code = hex(await rpc("eth_getCode", [row.contract_address, blockTag]), "consumed nonce escrow runtime");
      if (code === "0x" || createHash("sha256").update(Buffer.from(code.slice(2), "hex")).digest("hex") !== fresh.funding.runtime_sha256 ||
          !(["funded", "approved"] as ContractState[]).includes(await escrowState(fresh.funding, BigInt(row.escrow_id), blockTag))) {
        throw new CommerceIssue("Consumed nonce recovery cannot prove the same refundable escrow", 409);
      }
    }) };
  return withRefundTable(db => db.transaction(() => {
    const commitTime = Math.floor(Date.now() / 1000);
    const current = db.prepare(`SELECT * FROM customer_refund_intents
      WHERE id = ? AND owner_address = ? AND origin = ?`).get(id, session.ownerAddress, origin.origin) as RefundRow | undefined;
    if (!current || current.state !== row.state || current.wallet_open_count !== row.wallet_open_count ||
        current.wallet_attempt_id !== row.wallet_attempt_id || current.transaction_hash !== row.transaction_hash ||
        current.observed_hash || current.confirmed_hash || current.abi_json !== fresh.funding.abi_json ||
        !currentCommerceSession(db, session, origin, commitTime)) {
      throw new CommerceIssue("Refund retry was already opened or its journal changed", 409);
    }
    const attemptId = recordWalletAttempt(db, "refund", current, transaction, commitTime, row.wallet_opened_at);
    db.prepare(`UPDATE customer_refund_intents SET state = 'prepared', wallet_opened_at = ?,
      wallet_open_count = wallet_open_count + 1, wallet_attempt_id = ?, transaction_hash = NULL,
      transaction_json = ?, updated_at = ? WHERE id = ?`)
      .run(commitTime, attemptId, JSON.stringify(transaction), commitTime, id);
    return { refund: asRefund({ ...current, state: "prepared", transaction_hash: null,
      wallet_attempt_id: attemptId, wallet_opened_at: commitTime, wallet_open_count: current.wallet_open_count + 1 }),
      transaction, warning: "All earlier attempts remain recorded. A pending transaction may still succeed; replacement or legacy recovery can cost additional gas. The contract refunds this escrow only once." };
  }).immediate());
}

export function attachCustomerRefundHash(session: CustomerSession, origin: URL,
    id: string, transactionHash: string, attemptId?: string): RefundRecord {
  if (!idPattern.test(id) || !hashPattern.test(transactionHash)) {
    throw new CommerceIssue("Invalid refund transaction reference", 400);
  }
  return withRefundTable(db => db.transaction(() => {
    const row = db.prepare(`SELECT * FROM customer_refund_intents
      WHERE id = ? AND owner_address = ? AND origin = ?`)
      .get(id, session.ownerAddress, origin.origin) as RefundRow | undefined;
    if (!row) throw new CommerceIssue("Refund attempt is missing", 404);
    if (!attachWalletAttempt(db, "refund", row, transactionHash.toLowerCase(), attemptId)) return asRefund(row);
    if (row.wallet_opened_at === null ||
        (row.transaction_hash && row.transaction_hash !== transactionHash.toLowerCase()) ||
        (row.state !== "prepared" && row.state !== "submitted")) {
      throw new CommerceIssue("Refund attempt does not accept this transaction hash", 409);
    }
    db.prepare(`UPDATE customer_refund_intents SET transaction_hash = ?, state = 'submitted', updated_at = ?
      WHERE id = ?`).run(transactionHash.toLowerCase(), Math.floor(Date.now() / 1000), id);
    return asRefund({ ...row, transaction_hash: transactionHash.toLowerCase(), state: "submitted" });
  }).immediate());
}

function topicUint(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

async function findRefundHash(row: RefundRow): Promise<string | null> {
  const abi = pinnedInterface(row.abi_json);
  const latest = await rpc("eth_getBlockByNumber", ["latest", false]) as { number?: unknown } | null;
  const tip = quantity(latest?.number, "refund latest block number");
  if (tip > BigInt(Number.MAX_SAFE_INTEGER) || tip < BigInt(row.prepared_block)) return null;
  const topic = abi.getEvent("Refunded")?.topicHash;
  if (!topic) throw new Error("Refunded event ABI is unavailable");
  const first = BigInt(row.scan_next_block > Number(tip) ? row.prepared_block :
    Math.max(row.prepared_block, row.scan_next_block));
  for (let start = first, page = 0; start <= tip && page < 5; start += 1000n, page++) {
    const end = start + 999n < tip ? start + 999n : tip;
    const logs = await rpc("eth_getLogs", [{ address: row.contract_address,
      fromBlock: asQuantity(start), toBlock: asQuantity(end),
      topics: [topic, topicUint(BigInt(row.escrow_id)), zeroPadValue(row.owner_address, 32)] }]);
    if (!Array.isArray(logs) || logs.length > 1000) throw new Error("Refund log search was malformed or oversized");
    for (const value of logs) {
      if (!value || typeof value !== "object") throw new Error("Refund log was malformed");
      const entry = value as { address?: unknown; topics?: unknown; data?: unknown; transactionHash?: unknown };
      if (typeof entry.address !== "string" || getAddress(entry.address) !== getAddress(row.contract_address) ||
          !Array.isArray(entry.topics) || typeof entry.data !== "string" ||
          typeof entry.transactionHash !== "string" || !hashPattern.test(entry.transactionHash)) {
        throw new Error("Refund log identity was malformed");
      }
      const parsed = abi.parseLog({ topics: entry.topics as string[], data: entry.data });
      if (parsed?.name === "Refunded" && BigInt(parsed.args.id) === BigInt(row.escrow_id) &&
          getAddress(parsed.args.buyer) === row.owner_address &&
          getAddress(parsed.args.to) === row.owner_address &&
          BigInt(parsed.args.amount) === BigInt(row.amount_tinybar)) {
        return entry.transactionHash.toLowerCase();
      }
    }
    const next = end === tip ? BigInt(row.prepared_block) : end + 1n;
    withRefundTable(db => db.prepare(`UPDATE customer_refund_intents
      SET scan_next_block = ?, updated_at = ? WHERE id = ?`)
      .run(Number(next), Math.floor(Date.now() / 1000), row.id));
  }
  return null;
}

export async function reconcileCustomerRefund(session: CustomerSession, origin: URL,
    id: string): Promise<RefundRecord> {
  if (!idPattern.test(id)) throw new CommerceIssue("Invalid refund attempt reference", 400);
  const row = refundRow(session, origin, id);
  const abi = pinnedInterface(row.abi_json);
  await assertEvmRpcNetwork(networkConfigFromEnv(process.env));
  const eventHash = row.state === "executed" && row.confirmed_hash ? row.confirmed_hash : await findRefundHash(row);
  if (eventHash) {
    withRefundTable(db => db.transaction(() => {
      const current = db.prepare("SELECT observed_hash FROM customer_refund_intents WHERE id = ?")
        .get(id) as { observed_hash: string | null } | undefined;
      if (!current || (current.observed_hash && current.observed_hash !== eventHash)) {
        throw new Error("Refund event conflicts with the durable journal");
      }
      db.prepare(`UPDATE customer_refund_intents SET observed_hash = ?,
        state = CASE WHEN transaction_hash IS NOT NULL AND transaction_hash != ? AND state != 'executed'
          THEN 'conflict' ELSE state END, updated_at = ? WHERE id = ?`)
        .run(eventHash, eventHash, Math.floor(Date.now() / 1000), id);
    }).immediate());
  }
  const hash = eventHash ?? row.confirmed_hash ?? row.observed_hash ?? row.transaction_hash;
  if (!hash) return asRefund(refundRow(session, origin, id));
  function mark(state: "failed" | "conflict"): RefundRecord {
    return withRefundTable(db => {
      db.prepare(`UPDATE customer_refund_intents SET state = ?, updated_at = ?
        WHERE id = ? AND state != 'executed' AND wallet_attempt_id IS ? AND transaction_hash IS ?`)
        .run(state, Math.floor(Date.now() / 1000), id, row.wallet_attempt_id, row.transaction_hash);
      return asRefund(db.prepare("SELECT * FROM customer_refund_intents WHERE id = ?").get(id) as RefundRow);
    });
  }
  const [tx, receipt] = await Promise.all([
    rpc("eth_getTransactionByHash", [hash]), rpc("eth_getTransactionReceipt", [hash]),
  ]) as [Record<string, unknown> | null, Record<string, unknown> | null];
  if (!tx || !receipt) return asRefund(refundRow(session, origin, id));
  const intended = JSON.parse(row.transaction_json) as WalletTransaction;
  if (typeof tx.from !== "string" || getAddress(tx.from) !== row.owner_address ||
      typeof tx.to !== "string" || getAddress(tx.to) !== getAddress(row.contract_address) ||
      typeof tx.input !== "string" || tx.input.toLowerCase() !== intended.data.toLowerCase() ||
      quantity(tx.value, "refund transaction value") !== 0n ||
      String(tx.hash).toLowerCase() !== hash.toLowerCase()) return mark("conflict");
  const status = quantity(receipt.status, "refund receipt status");
  const config = networkConfigFromEnv(process.env);
  if (config.network !== "testnet") throw new Error("Refund reconciliation is testnet-only");
  const mirrorResponse = await fetch(`${config.mirrorBaseUrl}/api/v1/contracts/results/${hash}`, {
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" } });
  if (mirrorResponse.status === 404) return asRefund(refundRow(session, origin, id));
  if (!mirrorResponse.ok) throw new Error("Mirror refund receipt is unavailable");
  const mirror = await limitedJson(mirrorResponse) as Record<string, unknown>;
  if (!mirror || mirror.contract_id !== row.contract_id) throw new Error("Mirror refund contract ID mismatch");
  assertRefundReceiptHashes(hash, receipt.transactionHash, mirror.hash);
  if (status !== 1n || mirror.result !== "SUCCESS") {
    if (status === 0n && typeof mirror.result === "string" && /^[A-Z][A-Z0-9_]+$/.test(mirror.result) &&
        !["SUCCESS", "UNKNOWN", "PENDING"].includes(mirror.result)) return mark(eventHash ? "conflict" : "failed");
    throw new Error("RPC and Mirror disagree about the buyer refund");
  }
  if (!Array.isArray(receipt.logs)) throw new Error("Refund receipt has no logs");
  const refunds = receipt.logs.flatMap(value => {
    if (!value || typeof value !== "object") return [];
    const log = value as { address?: unknown; topics?: unknown; data?: unknown };
    if (typeof log.address !== "string" || getAddress(log.address) !== getAddress(row.contract_address) ||
        !Array.isArray(log.topics) || typeof log.data !== "string") return [];
    try {
      const event = abi.parseLog({ topics: log.topics as string[], data: log.data });
      return event?.name === "Refunded" ? [event] : [];
    } catch { return []; }
  });
  if (refunds.length !== 1) throw new Error("Refund receipt did not emit exactly one buyer Refund event");
  const event = refunds[0].args;
  if (BigInt(event.id) !== BigInt(row.escrow_id) || getAddress(event.buyer) !== row.owner_address ||
      getAddress(event.to) !== row.owner_address || BigInt(event.amount) !== BigInt(row.amount_tinybar)) {
    throw new Error("Refund event does not return the exact escrow amount to its buyer");
  }
  const funding = fundingRow(session, origin, row.funding_id);
  if (await escrowState(funding, BigInt(row.escrow_id)) !== "refunded") {
    throw new Error("Escrow storage does not report buyer refund");
  }
  return withRefundTable(db => db.transaction(() => {
    const current = db.prepare("SELECT confirmed_hash FROM customer_refund_intents WHERE id = ?")
      .get(id) as { confirmed_hash: string | null } | undefined;
    if (!current || (current.confirmed_hash && current.confirmed_hash !== hash)) {
      throw new Error("Refund journal changed while reconciling");
    }
    db.prepare(`UPDATE customer_refund_intents SET state = 'executed', confirmed_hash = ?, updated_at = ? WHERE id = ?`)
      .run(hash.toLowerCase(), Math.floor(Date.now() / 1000), id);
    return asRefund(db.prepare("SELECT * FROM customer_refund_intents WHERE id = ?").get(id) as RefundRow);
  }).immediate());
}
