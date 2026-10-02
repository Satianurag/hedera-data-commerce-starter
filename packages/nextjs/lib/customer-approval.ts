import { loadDirectSellerProfile } from "@neuron/hedera/direct-seller-file";
import { currentCommerceSession, assertRefundReceiptHashes } from "./commerce-guards";
import { walletAttemptTable, walletNonce, recordWalletAttempt, attachWalletAttempt } from "./customer-wallet-attempts";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type Database from "better-sqlite3";
import { Interface, computeAddress, getAddress, keccak256, zeroPadValue } from "ethers";
import { assertEvmRpcNetwork, checkDirectSellerBinding, getMirrorAccount, getTopicMessageBySequence,
  inspectSignedTopicEnvelope, networkConfigFromEnv } from "@neuron/hedera";
import { withCustomerDatabase, type CustomerSession } from "./customer-auth";
import { CommerceIssue } from "./customer-commerce";
import { customerFundingPinnedInterface, reconcileCustomerFunding } from "./customer-funding";
import { selectCompletedTransport, type Transport } from "./customer-approval-evidence";
import { gatewayServerEndpoint } from "./gateway-endpoint";

const idPattern = /^[0-9a-f]{32}$/;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const shaPattern = /^[0-9a-f]{64}$/;
const hederaId = /^0\.0\.[1-9]\d*$/;
// cmd/legacy-request sends numeric service_id 1 with neuron/ADSB/0.0.2.
// This gateway evidence cannot support a differently named quote service.
const legacyAdsbServiceId = "1";
const pinnedFragments = [
  "function approve(uint256 id)",
  "function escrows(uint256 id) view returns (address buyer,address seller,uint256 amount,uint64 quoteExpiresAt,uint64 refundAfter,bytes32 termsHash,uint8 state)",
  "event Approved(uint256 indexed id,address indexed buyer)",
] as const;
function pinnedEscrow(session: CustomerSession, origin: URL, funding: FundingContext): Interface {
  if (!funding.abi_json || funding.abi_json.length > 8192) {
    throw new Error("Original funded escrow ABI was not pinned");
  }
  const parsed = JSON.parse(funding.abi_json) as unknown;
  if (!Array.isArray(parsed) || parsed.length < 6 || parsed.length > 20 ||
      !parsed.every(item => typeof item === "string" && item.length < 500) ||
      !pinnedFragments.every(fragment => parsed.includes(fragment))) {
    throw new Error("Original escrow ABI does not support safe buyer approval");
  }
  return customerFundingPinnedInterface(session, origin, funding.id);
}

type ApprovalState = "prepared" | "wallet-opened" | "submitted" | "executed" | "failed" | "conflict";
type WalletTransaction = Readonly<{ from: string; to: string; value: "0x0"; data: string;
  gas: string; gasPrice: string; chainId: "0x128"; nonce?: string }>;
export type ApprovalRecord = Readonly<{
  walletAttemptId?: string | null; id: string; fundingId: string; state: ApprovalState; escrowId: string;
  transactionHash: string | null; reportedHash: string | null; observedHash: string | null;
  requestTopic: string; requestSequence: number; transportBytes: number;
  transportOpenedAt: string; transportClosedAt: string; preparedAt: number;
  acknowledgedAt: number | null;
}>;

type FundingContext = {
  id: string; session_id: string; owner_address: string; origin: string; state: string;
  contract_state: string | null; contract_id: string; contract_address: string;
  seller_address: string; terms_hash: string; amount_tinybar: string;
  quote_expires_at: number; refund_after: number; escrow_id: string | null;
  confirmed_hash: string | null; runtime_sha256: string | null; abi_json: string | null;
  seller_account: string; quote_session: string; terms_json: string;
  quote_topic: string; quote_sequence: number; quote_terms_hash: string;
  quote_duration_seconds: number;
};
type ApprovalRow = {
  wallet_attempt_id: string | null;
  id: string; funding_id: string; session_id: string; owner_address: string; origin: string;
  state: ApprovalState; escrow_id: string; contract_id: string; contract_address: string;
  prepared_block: number; scan_next_block: number; prepared_at: number;
  transaction_json: string; transaction_hash: string | null; observed_hash: string | null;
  confirmed_hash: string | null; request_topic: string; request_sequence: number;
  transport_bytes: number; transport_opened_at: string; transport_closed_at: string;
  buyer_acknowledged_at: number | null;
};
type RequestRow = { state: string; seller_account: string; transaction_id: string | null;
  payload_sha256: string | null; topic_sequence: number | null };
const asQuantity = (value: bigint): string => `0x${value.toString(16)}`;
function quantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new Error(`${label} is not a JSON-RPC quantity`);
  }
  return BigInt(value);
}
function bytes(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`${label} is not canonical hex bytes`);
  }
  return value;
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Network response has no body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 1_048_576) { await reader.cancel(); throw new Error("Network response is too large"); }
    chunks.push(value);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const network = networkConfigFromEnv(process.env);
  if (network.network !== "testnet" || !network.rpcUrl) throw new Error("Approval requires an explicit testnet RPC");
  const response = await fetch(network.rpcUrl, { method: "POST", cache: "no-store", redirect: "error",
    signal: AbortSignal.timeout(10_000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!response.ok) throw new Error(`Testnet RPC returned ${response.status}`);
  const body = await boundedJson(response) as { jsonrpc?: unknown; id?: unknown; error?: unknown; result?: unknown };
  if (!body || body.jsonrpc !== "2.0" || body.id !== 1 || body.error !== undefined ||
      !Object.hasOwn(body, "result")) throw new Error(`Testnet RPC ${method} did not return a result`);
  return body.result;
}
function withApprovalTable<T>(work: (db: Database.Database) => T): T {
  return withCustomerDatabase(db => {
    db.exec(`CREATE TABLE IF NOT EXISTS customer_approval_intents (
      id TEXT PRIMARY KEY, funding_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
      owner_address TEXT NOT NULL, origin TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared','wallet-opened','submitted','executed','failed','conflict')),
      escrow_id TEXT NOT NULL, contract_id TEXT NOT NULL, contract_address TEXT NOT NULL,
      prepared_block INTEGER NOT NULL, scan_next_block INTEGER NOT NULL, prepared_at INTEGER NOT NULL,
      transaction_json TEXT NOT NULL, transaction_hash TEXT UNIQUE, observed_hash TEXT UNIQUE,
      confirmed_hash TEXT UNIQUE, request_topic TEXT NOT NULL, request_sequence INTEGER NOT NULL,
      transport_bytes INTEGER NOT NULL, transport_opened_at TEXT NOT NULL,
      transport_closed_at TEXT NOT NULL, buyer_acknowledged_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS customer_approval_owner_idx ON customer_approval_intents
      (owner_address, origin, prepared_at DESC);`);
    walletAttemptTable(db);
    const columns = db.pragma("table_info(customer_approval_intents)") as { name: string }[];
    if (!columns.some(column => column.name === "wallet_attempt_id")) {
      db.exec("ALTER TABLE customer_approval_intents ADD COLUMN wallet_attempt_id TEXT");
    }
    return work(db);
  });
}
function currentBuyerSession(db: Database.Database, session: CustomerSession, origin: URL,
    now: number): boolean {
  return currentCommerceSession(db, session, origin, now);
}
function asRecord(row: ApprovalRow): ApprovalRecord {
  return { walletAttemptId: row.wallet_attempt_id, id: row.id, fundingId: row.funding_id, state: row.state, escrowId: row.escrow_id,
    transactionHash: row.confirmed_hash ?? row.observed_hash ?? row.transaction_hash,
    reportedHash: row.transaction_hash, observedHash: row.observed_hash,
    requestTopic: row.request_topic, requestSequence: row.request_sequence,
    transportBytes: row.transport_bytes, transportOpenedAt: row.transport_opened_at,
    transportClosedAt: row.transport_closed_at, preparedAt: row.prepared_at,
    acknowledgedAt: row.buyer_acknowledged_at };
}
function approvalRow(session: CustomerSession, origin: URL, id: string): ApprovalRow {
  if (!idPattern.test(id)) throw new CommerceIssue("Invalid approval reference", 400);
  const row = withApprovalTable(db => db.prepare(`SELECT * FROM customer_approval_intents
    WHERE id = ? AND owner_address = ? AND origin = ?`).get(id, session.ownerAddress, origin.origin) as ApprovalRow | undefined);
  if (!row) throw new CommerceIssue("Approval attempt is missing", 404);
  return row;
}
function fundingContext(session: CustomerSession, origin: URL, id: string): FundingContext {
  if (!idPattern.test(id)) throw new CommerceIssue("Invalid funded escrow reference", 400);
  const row = withCustomerDatabase(db => db.prepare(`SELECT f.id, f.session_id, f.owner_address, f.origin,
    f.state, f.contract_state, f.contract_id, f.contract_address, f.seller_address,
    f.terms_hash, f.amount_tinybar, f.quote_expires_at, f.refund_after, f.escrow_id,
    f.confirmed_hash, f.runtime_sha256, f.abi_json, q.seller_account,
    q.session_id AS quote_session, q.terms_json,
    q.quote_topic, q.quote_sequence, q.terms_hash AS quote_terms_hash
    FROM customer_funding_intents f JOIN customer_commerce_intents q ON q.id = f.quote_intent_id
    WHERE f.id = ? AND f.owner_address = ? AND f.origin = ?`)
    .get(id, session.ownerAddress, origin.origin) as Omit<FundingContext, "quote_duration_seconds"> | undefined);
  if (!row) throw new CommerceIssue("Funded escrow is missing", 404);
  if (row.session_id !== row.quote_session || !idPattern.test(row.session_id)) {
    throw new CommerceIssue("Original buyer quote and funding session do not match", 409);
  }
  let terms: Record<string, unknown>;
  try { terms = JSON.parse(row.terms_json) as Record<string, unknown>; }
  catch { throw new CommerceIssue("Original seller quote is unreadable", 409); }
  if (!terms || typeof terms !== "object" || Array.isArray(terms) ||
      terms.serviceId !== legacyAdsbServiceId || terms.sellerAccountId !== row.seller_account ||
      terms.sessionId !== row.session_id || terms.buyerAddress !== row.owner_address ||
      terms.asset !== "HBAR" || terms.escrowContractId !== row.contract_id ||
      terms.escrowAddress !== row.contract_address || terms.sellerAddress !== row.seller_address ||
      terms.amountTinybar !== row.amount_tinybar ||
      typeof terms.durationSeconds !== "string" ||
      !/^[1-9]\d{0,4}$/.test(terms.durationSeconds) ||
      Number(terms.durationSeconds) > 86_400) {
    throw new CommerceIssue("Seller quote is not for this exact legacy ADS-B request and funded escrow", 409);
  }
  return { ...row, quote_duration_seconds: Number(terms.durationSeconds) };
}

async function freshSellerIdentity(funding: FundingContext): Promise<string> {
  const network = networkConfigFromEnv(process.env);
  const direct = loadDirectSellerProfile(process.env);
  if (direct) {
    if (direct.accountId !== funding.seller_account || direct.quoteTopicId !== funding.quote_topic) {
      throw new Error("Original seller quote differs from the pinned direct profile");
    }
    await checkDirectSellerBinding(network, direct);
  }
  if (network.network !== "testnet" || !hederaId.test(funding.quote_topic) ||
      !Number.isSafeInteger(funding.quote_sequence) || funding.quote_sequence < 1 ||
      funding.quote_terms_hash.toLowerCase() !== funding.terms_hash.toLowerCase()) {
    throw new Error("Original quote identity is incomplete");
  }
  const [message, account] = await Promise.all([
    getTopicMessageBySequence(network, funding.quote_topic, funding.quote_sequence),
    getMirrorAccount(network, funding.seller_account),
  ]);
  if (message.topicId !== funding.quote_topic || message.sequenceNumber !== funding.quote_sequence ||
      message.payerAccountId !== funding.seller_account) {
    throw new Error("Original signed quote HCS source changed");
  }
  const envelope = inspectSignedTopicEnvelope(message.bytes);
  if (!envelope || !/^0[23][0-9a-fA-F]{64}$/.test(envelope.compressedPublicKey) ||
      keccak256(envelope.payload).toLowerCase() !== funding.terms_hash.toLowerCase() ||
      new TextDecoder("utf-8", { fatal: true }).decode(envelope.payload) !== funding.terms_json ||
      account.key?._type !== "ECDSA_SECP256K1" ||
      account.key.key.toLowerCase() !== envelope.compressedPublicKey.toLowerCase() ||
      typeof account.evm_address !== "string" ||
      getAddress(account.evm_address) !== getAddress(funding.seller_address) ||
      computeAddress(`0x${envelope.compressedPublicKey}`) !== getAddress(funding.seller_address) ||
      getAddress(envelope.senderAddress) !== getAddress(funding.seller_address)) {
    throw new Error("Seller key or EVM payee no longer matches the original signed quote");
  }
  return envelope.compressedPublicKey.toLowerCase();
}
function token(): Buffer {
  const path = process.env.NEURON_SESSION_TOKEN_FILE;
  if (!path || !isAbsolute(path)) throw new Error("Gateway session token path is missing");
  const parent = lstatSync(dirname(path));
  const info = lstatSync(path);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 ||
      (process.getuid && parent.uid !== process.getuid()) ||
      !info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) throw new Error("Gateway session token is not owner-only");
  const value = readFileSync(path, "utf8").trim();
  if (!shaPattern.test(value.toLowerCase())) throw new Error("Gateway session token is invalid");
  return Buffer.from(value, "hex");
}

async function transportEvidence(session: CustomerSession, purchaseSessionId: string,
    seller: string): Promise<Transport> {
  if (!process.env.NEURON_GATEWAY_INTERNAL_ORIGIN) {
    throw new Error("Approval requires a colocated private gateway endpoint");
  }
  const configured = process.env.NEURON_GATEWAY_WS_URL;
  if (!configured || !hederaId.test(seller) || process.env.NEURON_SELLER_ACCOUNT_ID !== seller ||
      process.env.NEURON_COMMERCE_SELLER_ACCOUNT_ID !== seller ||
      process.env.NEURON_COMMERCE_SERVICE_ID !== legacyAdsbServiceId) {
    throw new Error("Gateway seller does not match the quote");
  }
  const publicUrl = new URL(configured);
  const local = process.env.NEURON_ENABLE_LOCAL_STREAM === "true" && publicUrl.protocol === "ws:" &&
    ["127.0.0.1", "localhost"].includes(publicUrl.hostname) && Boolean(publicUrl.port);
  const remote = process.env.NEURON_ENABLE_REMOTE_STREAM === "true" && publicUrl.protocol === "wss:" &&
    !publicUrl.port && publicUrl.hostname === process.env.NEURON_GATEWAY_PUBLIC_HOST;
  if ((!local && !remote) || publicUrl.pathname !== "/stream" || publicUrl.search || publicUrl.hash ||
      publicUrl.username || publicUrl.password) {
    throw new Error("Configured gateway WSS identity is invalid for approval");
  }
  const endpoint = gatewayServerEndpoint(publicUrl, "/transport-evidence");
  const owner = session.ownerAddress.toLowerCase();
  const signature = createHmac("sha256", token())
    .update(`transport-evidence:${purchaseSessionId}:${owner}:${seller}`).digest("hex");
  const response = await fetch(endpoint, { method: "POST", cache: "no-store", redirect: "error",
    signal: AbortSignal.timeout(5_000), headers: { "X-Neuron-Session-ID": purchaseSessionId,
      "X-Neuron-Owner": owner, "X-Neuron-Auth": signature } });
  if (!response.ok) throw new Error(`Private gateway evidence is unavailable (${response.status})`);
  return await boundedJson(response) as Transport;
}

async function confirmedRequest(session: CustomerSession, origin: URL, purchaseSessionId: string,
    seller: string): Promise<Readonly<{
  topic: string; sequence: number; consensusMs: number;
}>> {
  const request = withCustomerDatabase(db => db.prepare(`SELECT state, seller_account, transaction_id,
    payload_sha256, topic_sequence FROM customer_service_requests
    WHERE session_id = ? AND owner_address = ? AND origin = ?`)
    .get(purchaseSessionId, session.ownerAddress, origin.origin) as RequestRow | undefined);
  const topic = process.env.NEURON_SELLER_STDIN_TOPIC_ID ?? "";
  if (!request || request.state !== "confirmed" || request.seller_account !== seller ||
      !request.transaction_id || !/^0\.0\.[1-9]\d*@\d+\.\d{9}$/.test(request.transaction_id) ||
      !request.payload_sha256 || !shaPattern.test(request.payload_sha256) ||
      !request.topic_sequence || !Number.isSafeInteger(request.topic_sequence) || !hederaId.test(topic)) {
    throw new CommerceIssue("A confirmed same-session seller HCS request is required", 409);
  }
  const network = networkConfigFromEnv(process.env);
  if (network.network !== "testnet") throw new Error("Approval is testnet-only");
  const message = await getTopicMessageBySequence(network, topic, request.topic_sequence);
  const hash = createHash("sha256").update(message.bytes).digest("hex");
  if (message.topicId !== topic || message.sequenceNumber !== request.topic_sequence ||
      message.payerAccountId !== process.env.HEDERA_OPERATOR_ACCOUNT_ID ||
      hash !== request.payload_sha256) {
    throw new Error("Seller request HCS bytes, payer or sequence do not match the journal");
  }
  const transactionId = request.transaction_id;
  const transactionParts = /^(0\.0\.[1-9]\d*)@(\d+)\.(\d{9})$/.exec(transactionId);
  if (!transactionParts || transactionParts[1] !== process.env.HEDERA_OPERATOR_ACCOUNT_ID) {
    throw new Error("Seller request transaction payer is not the configured operator");
  }
  const mirrorId = `${transactionParts[1]}-${transactionParts[2]}-${transactionParts[3]}`;
  const transactionResponse = await fetch(`${network.mirrorBaseUrl}/api/v1/transactions/${mirrorId}`, {
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" },
  });
  if (!transactionResponse.ok) throw new Error("Seller request transaction is unavailable on testnet Mirror");
  const transactionBody = await boundedJson(transactionResponse) as { transactions?: unknown };
  const matches = Array.isArray(transactionBody?.transactions) ? transactionBody.transactions.filter(item => {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    return row.transaction_id === mirrorId && row.name === "CONSENSUSSUBMITMESSAGE" &&
      row.result === "SUCCESS" && row.entity_id === topic &&
      row.consensus_timestamp === message.consensusTimestamp;
  }) : [];
  if (matches.length !== 1) {
    throw new Error("Seller request transaction does not match the exact HCS message");
  }
  const [seconds, fraction] = message.consensusTimestamp.split(".");
  const consensusMs = Number(seconds) * 1000 + Math.ceil(Number(fraction.padEnd(9, "0")) / 1_000_000);
  if (!Number.isSafeInteger(consensusMs) || consensusMs <= 0) throw new Error("Seller request timestamp is invalid");
  return { topic, sequence: request.topic_sequence, consensusMs };
}

async function contractPreflight(funding: FundingContext, session: CustomerSession,
    origin: URL, blockTag = "latest"): Promise<Readonly<{
  transaction: WalletTransaction; blockNumber: number; fundedAtMs: number;
}>> {
  if (!funding.escrow_id || !/^[1-9]\d*$/.test(funding.escrow_id) || !funding.confirmed_hash ||
      !hashPattern.test(funding.confirmed_hash) || !funding.runtime_sha256 ||
      !shaPattern.test(funding.runtime_sha256)) {
    throw new Error("Funded escrow has no complete verified deployment record");
  }
  const network = networkConfigFromEnv(process.env);
  if (network.network !== "testnet" || !network.rpcUrl) throw new Error("Approval requires testnet and explicit RPC");
  await assertEvmRpcNetwork(network);
  const address = getAddress(funding.contract_address);
  const id = BigInt(funding.escrow_id);
  const abi = pinnedEscrow(session, origin, funding);
  const data = abi.encodeFunctionData("approve", [id]);
  const [chain, code, latest, stored, fundedReceipt, gasPriceRaw, balanceRaw] = await Promise.all([
    rpc("eth_chainId", []), rpc("eth_getCode", [address, blockTag]),
    rpc("eth_getBlockByNumber", [blockTag, false]),
    rpc("eth_call", [{ to: address, data: abi.encodeFunctionData("escrows", [id]) }, blockTag]),
    rpc("eth_getTransactionReceipt", [funding.confirmed_hash]),
    rpc("eth_gasPrice", []), rpc("eth_getBalance", [session.ownerAddress, "latest"]),
  ]);
  if (quantity(chain, "approval chain") !== 296n) throw new Error("Approval RPC is not Hedera testnet");
  const runtime = bytes(code, "approval contract runtime");
  if (runtime === "0x" || createHash("sha256").update(Buffer.from(runtime.slice(2), "hex")).digest("hex") !==
      funding.runtime_sha256) throw new Error("Escrow runtime differs from its vetted funding revision");
  if (!latest || typeof latest !== "object") throw new Error("Approval RPC has no latest block");
  const block = latest as { number?: unknown; timestamp?: unknown };
  const blockNumber = quantity(block.number, "approval block number");
  const blockTime = quantity(block.timestamp, "approval block time");
  if (blockNumber > BigInt(Number.MAX_SAFE_INTEGER) ||
      blockTime + 120n >= BigInt(funding.refund_after) ||
      Math.floor(Date.now() / 1000) + 120 >= funding.refund_after) {
    throw new CommerceIssue("Escrow approval deadline is too close or has passed", 409);
  }
  const storage = abi.decodeFunctionResult("escrows", bytes(stored, "escrow storage"));
  if (getAddress(storage.buyer) !== session.ownerAddress ||
      getAddress(storage.seller) !== getAddress(funding.seller_address) ||
      BigInt(storage.amount) !== BigInt(funding.amount_tinybar) ||
      BigInt(storage.quoteExpiresAt) !== BigInt(funding.quote_expires_at) ||
      BigInt(storage.refundAfter) !== BigInt(funding.refund_after) ||
      String(storage.termsHash).toLowerCase() !== funding.terms_hash.toLowerCase() ||
      BigInt(storage.state) !== 1n) {
    throw new CommerceIssue("Escrow is no longer the original funded buyer and seller state", 409);
  }
  if (!fundedReceipt || typeof fundedReceipt !== "object") throw new Error("Funding receipt is unavailable");
  const receipt = fundedReceipt as { status?: unknown; blockNumber?: unknown; transactionHash?: unknown };
  if (quantity(receipt.status, "funding receipt status") !== 1n ||
      typeof receipt.transactionHash !== "string" ||
      receipt.transactionHash.toLowerCase() !== funding.confirmed_hash.toLowerCase()) {
    throw new Error("Funding receipt changed");
  }
  const fundedBlockNumber = quantity(receipt.blockNumber, "funded block number");
  const fundedBlock = await rpc("eth_getBlockByNumber", [asQuantity(fundedBlockNumber), false]) as
    { timestamp?: unknown } | null;
  const fundedAt = quantity(fundedBlock?.timestamp, "funded block time");
  if (fundedAt > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000))) {
    throw new Error("Funded time exceeds safe precision");
  }
  const mirrorResponse = await fetch(`${network.mirrorBaseUrl}/api/v1/contracts/${funding.contract_id}`, {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" } });
  if (!mirrorResponse.ok) throw new Error("Escrow contract metadata is unavailable");
  const metadata = await boundedJson(mirrorResponse) as Record<string, unknown>;
  if (!metadata || metadata.contract_id !== funding.contract_id || metadata.deleted !== false ||
      typeof metadata.evm_address !== "string" || getAddress(metadata.evm_address) !== address ||
      typeof metadata.expiration_timestamp !== "string" ||
      !/^\d+\.\d{1,9}$/.test(metadata.expiration_timestamp) ||
      BigInt(metadata.expiration_timestamp.split(".")[0]) <= BigInt(funding.refund_after) + 120n) {
    throw new Error("Escrow ID, address or renewal lifetime is not safe for approval");
  }
  const feeText = process.env.NEURON_COMMERCE_MAX_TX_FEE_TINYBAR ?? "";
  if (!/^[1-9]\d{0,8}$/.test(feeText) || BigInt(feeText) > 100_000_000n) {
    throw new Error("Approval requires a fee cap no greater than 1 HBAR");
  }
  const gasPrice = quantity(gasPriceRaw, "approval gas price");
  const gasEstimate = quantity(await rpc("eth_estimateGas", [{ from: session.ownerAddress,
    to: address, value: "0x0", data }]), "approval gas estimate");
  const gasLimit = gasEstimate * 12n / 10n + 10_000n;
  const balance = quantity(balanceRaw, "approval gas balance");
  if (gasPrice <= 0n || gasLimit <= 0n || gasLimit > 250_000n ||
      gasLimit * gasPrice > BigInt(feeText) * 10_000_000_000n || balance < gasLimit * gasPrice) {
    throw new Error("Buyer approval gas, balance or fee exceeds the configured cap");
  }
  return { transaction: { from: session.ownerAddress, to: address, value: "0x0",
    data, gas: asQuantity(gasLimit), gasPrice: asQuantity(gasPrice), chainId: "0x128" },
    blockNumber: Number(blockNumber), fundedAtMs: Number(fundedAt) * 1000 };
}

export function approvalEnabled(): boolean {
  return process.env.HEDERA_NETWORK === "testnet" &&
    process.env.NEURON_ENABLE_CUSTOMER_APPROVAL === "true" &&
    process.env.NEURON_ENABLE_CUSTOMER_AUTH === "true" &&
    process.env.NEURON_ENABLE_CUSTOMER_FUNDING === "true";
}

export function approvalForFunding(session: CustomerSession, origin: URL,
    fundingId: string): ApprovalRecord | null {
  if (!idPattern.test(fundingId)) throw new CommerceIssue("Invalid funded escrow reference", 400);
  return withApprovalTable(db => {
    const row = db.prepare(`SELECT * FROM customer_approval_intents WHERE funding_id = ?
      AND owner_address = ? AND origin = ?`).get(fundingId, session.ownerAddress, origin.origin) as ApprovalRow | undefined;
    return row ? asRecord(row) : null;
  });
}

export async function prepareCustomerApproval(session: CustomerSession, origin: URL,
    fundingId: string): Promise<Readonly<{ approval: ApprovalRecord; transaction: WalletTransaction }>> {
  if (!approvalEnabled()) throw new CommerceIssue("Buyer approval is disabled", 404);
  const existing = approvalForFunding(session, origin, fundingId);
  if (existing) throw new CommerceIssue("This escrow already has an approval attempt; reconcile it first", 409);
  const confirmed = await reconcileCustomerFunding(session, origin, fundingId);
  if (confirmed.state !== "executed" || confirmed.contractState !== "funded" || !confirmed.escrowId) {
    throw new CommerceIssue("A verified funded escrow is required before approval", 409);
  }
  const funding = fundingContext(session, origin, fundingId);
  if (funding.state !== "executed" || funding.escrow_id !== confirmed.escrowId) {
    throw new CommerceIssue("Funding journal changed during approval", 409);
  }
  const { transaction, blockNumber, fundedAtMs } = await contractPreflight(funding, session, origin);
  const sellerPublicKey = await freshSellerIdentity(funding);
  const request = await confirmedRequest(session, origin, funding.session_id, funding.seller_account);
  const evidence = await transportEvidence(session, funding.session_id, funding.seller_account);
  const completed = selectCompletedTransport(evidence, session.ownerAddress, funding.session_id,
    funding.seller_account, sellerPublicKey,
    Math.max(fundedAtMs, request.consensusMs), funding.refund_after * 1000,
    funding.quote_duration_seconds * 1000);
  if (!completed) {
    throw new CommerceIssue("No completed positive-byte transport covers the quoted duration after funding and the confirmed seller request", 409);
  }
  return withApprovalTable(db => db.transaction(() => {
    const now = Math.floor(Date.now() / 1000);
    if (!currentBuyerSession(db, session, origin, now) || now + 120 >= funding.refund_after) {
      throw new CommerceIssue("Buyer session or approval deadline expired", 409);
    }
    const duplicate = db.prepare("SELECT id FROM customer_approval_intents WHERE funding_id = ?")
      .get(fundingId) as { id: string } | undefined;
    if (duplicate) throw new CommerceIssue("An approval attempt already exists", 409);
    const stillFunded = db.prepare("SELECT state, escrow_id FROM customer_funding_intents WHERE id = ?")
      .get(fundingId) as { state: string; escrow_id: string | null } | undefined;
    if (!stillFunded || stillFunded.state !== "executed" || stillFunded.escrow_id !== confirmed.escrowId) {
      throw new CommerceIssue("Funding journal changed during approval", 409);
    }
    const id = randomBytes(16).toString("hex");
    db.prepare(`INSERT INTO customer_approval_intents
      (id,funding_id,session_id,owner_address,origin,state,escrow_id,contract_id,contract_address,
       prepared_block,scan_next_block,prepared_at,transaction_json,request_topic,request_sequence,
       transport_bytes,transport_opened_at,transport_closed_at,updated_at)
      VALUES (?,?,?,?,?,'prepared',?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, fundingId,
      session.sessionId, session.ownerAddress, origin.origin, confirmed.escrowId,
      funding.contract_id, funding.contract_address, blockNumber, blockNumber, now,
      JSON.stringify(transaction), request.topic, request.sequence, completed.bytes,
      completed.openedAt, completed.closedAt, now);
    const row = db.prepare("SELECT * FROM customer_approval_intents WHERE id = ?").get(id) as ApprovalRow;
    return { approval: asRecord(row), transaction };
  }).immediate());
}

export async function markCustomerApprovalWalletOpened(session: CustomerSession, origin: URL,
    id: string, acknowledged: boolean, retry = false): Promise<Readonly<{
      approval: ApprovalRecord; transaction: WalletTransaction }>> {
  if (acknowledged !== true) throw new CommerceIssue("Explicit buyer transport acknowledgement is required", 400);
  if (!approvalEnabled()) throw new CommerceIssue("Buyer approval is disabled", 404);
  if (retry) await reconcileCustomerApproval(session, origin, id);
  const row = approvalRow(session, origin, id);
  const now = Math.floor(Date.now() / 1000);
  if ((!retry && row.state !== "prepared") ||
      (retry && (!["wallet-opened", "submitted", "failed"].includes(row.state) ||
        row.observed_hash || row.confirmed_hash || row.buyer_acknowledged_at === null ||
        (row.state !== "failed" && row.buyer_acknowledged_at > now - 60))) || session.expiresAt <= now) {
    throw new CommerceIssue("Approval wallet attempt is unavailable or was already opened", 409);
  }
  const funding = fundingContext(session, origin, row.funding_id);
  const confirmed = await reconcileCustomerFunding(session, origin, row.funding_id);
  if (confirmed.state !== "executed" || confirmed.contractState !== "funded" ||
      confirmed.escrowId !== row.escrow_id || funding.state !== "executed") {
    throw new CommerceIssue("Escrow is no longer the original funded buyer state", 409);
  }
  const fresh = await contractPreflight(funding, session, origin);
  const sellerPublicKey = await freshSellerIdentity(funding);
  const request = await confirmedRequest(session, origin, funding.session_id, funding.seller_account);
  const evidence = await transportEvidence(session, funding.session_id, funding.seller_account);
  const completed = selectCompletedTransport(evidence, session.ownerAddress, funding.session_id,
    funding.seller_account, sellerPublicKey,
    Math.max(fresh.fundedAtMs, request.consensusMs), funding.refund_after * 1000,
    funding.quote_duration_seconds * 1000,
    { bytes: row.transport_bytes, openedAt: row.transport_opened_at,
      closedAt: row.transport_closed_at });
  if (!completed) {
    throw new CommerceIssue("Original completed transport no longer covers the funded request and quoted duration", 409);
  }
  if (request.topic !== row.request_topic || request.sequence !== row.request_sequence ||
      completed.openedAt !== row.transport_opened_at ||
      completed.closedAt !== row.transport_closed_at || completed.bytes !== row.transport_bytes) {
    throw new CommerceIssue("Original request or transport record changed before wallet approval", 409);
  }
  const transaction = { ...fresh.transaction, nonce: await walletNonce(rpc, session.ownerAddress,
    retry ? row.transaction_json : undefined, row.state === "failed", async blockTag => {
      await contractPreflight(funding, session, origin, blockTag);
    }) };
  const original = row;
  return withApprovalTable(db => db.transaction(() => {
    const row = db.prepare(`SELECT * FROM customer_approval_intents WHERE id = ?
      AND owner_address = ? AND origin = ?`)
      .get(id, session.ownerAddress, origin.origin) as ApprovalRow | undefined;
    if (!row || row.state !== original.state || row.wallet_attempt_id !== original.wallet_attempt_id ||
        row.buyer_acknowledged_at !== original.buyer_acknowledged_at ||
        row.transaction_hash !== original.transaction_hash || row.observed_hash || row.confirmed_hash ||
        !currentBuyerSession(db, session, origin, Math.floor(Date.now() / 1000))) {
      throw new CommerceIssue("Approval wallet attempt is unavailable or was already opened", 409);
    }
    const now = Math.floor(Date.now() / 1000);
    if (now + 120 >= funding.refund_after) throw new CommerceIssue("Approval deadline expired during preflight", 409);
    const attemptId = recordWalletAttempt(db, "approval", row, transaction, now, retry ? row.buyer_acknowledged_at : null);
    db.prepare(`UPDATE customer_approval_intents SET state = 'wallet-opened',
      transaction_json = ?, buyer_acknowledged_at = ?, wallet_attempt_id = ?, transaction_hash = NULL, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(transaction), now, attemptId, now, id);
    return { approval: asRecord({ ...row, state: "wallet-opened", buyer_acknowledged_at: now, wallet_attempt_id: attemptId, transaction_hash: null }),
      transaction };
  }).immediate());
}

export function attachCustomerApprovalHash(session: CustomerSession, origin: URL,
    id: string, hash: string, attemptId?: string): ApprovalRecord {
  if (!hashPattern.test(hash)) throw new CommerceIssue("Invalid approval transaction hash", 400);
  return withApprovalTable(db => db.transaction(() => {
    const row = db.prepare(`SELECT * FROM customer_approval_intents WHERE id = ?
      AND owner_address = ? AND origin = ?`).get(id, session.ownerAddress, origin.origin) as ApprovalRow | undefined;
    if (!row) throw new CommerceIssue("Approval intent is missing", 404);
    if (!attachWalletAttempt(db, "approval", row, hash.toLowerCase(), attemptId)) return asRecord(row);
    if ((row.state !== "wallet-opened" && row.state !== "submitted") ||
        (row.transaction_hash && row.transaction_hash !== hash.toLowerCase())) {
      throw new CommerceIssue("Approval hash does not match the durable wallet attempt", 409);
    }
    db.prepare(`UPDATE customer_approval_intents SET state = 'submitted', transaction_hash = ?,
      updated_at = ? WHERE id = ?`).run(hash.toLowerCase(), Math.floor(Date.now() / 1000), id);
    return asRecord({ ...row, state: "submitted", transaction_hash: hash.toLowerCase() });
  }).immediate());
}

async function findApprovedHash(row: ApprovalRow, abi: Interface): Promise<string | null> {
  const latest = await rpc("eth_getBlockByNumber", ["latest", false]) as { number?: unknown } | null;
  const tip = quantity(latest?.number, "approval log tip");
  if (tip > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Approval log range is unsafe");
  if (tip < BigInt(row.prepared_block)) return null;
  let start = BigInt(Math.max(row.prepared_block, row.scan_next_block));
  if (start > tip) start = BigInt(row.prepared_block);
  const topic = abi.getEvent("Approved")?.topicHash;
  if (!topic) throw new Error("Approved event ABI is unavailable");
  for (let page = 0; start <= tip && page < 5; page++) {
    const end = start + 999n < tip ? start + 999n : tip;
    const logs = await rpc("eth_getLogs", [{ address: row.contract_address,
      fromBlock: asQuantity(start), toBlock: asQuantity(end),
      topics: [topic, `0x${BigInt(row.escrow_id).toString(16).padStart(64, "0")}`,
        zeroPadValue(row.owner_address, 32)] }]);
    if (!Array.isArray(logs) || logs.length > 1000) throw new Error("Approval log search was malformed or oversized");
    for (const raw of logs) {
      if (!raw || typeof raw !== "object") throw new Error("Approval log was malformed");
      const entry = raw as { address?: unknown; topics?: unknown; data?: unknown; transactionHash?: unknown };
      if (typeof entry.address !== "string" || getAddress(entry.address) !== getAddress(row.contract_address) ||
          !Array.isArray(entry.topics) || typeof entry.data !== "string" ||
          typeof entry.transactionHash !== "string" || !hashPattern.test(entry.transactionHash)) {
        throw new Error("Approval log identity was malformed");
      }
      const parsed = abi.parseLog({ topics: entry.topics as string[], data: entry.data });
      if (parsed?.name === "Approved" && BigInt(parsed.args.id) === BigInt(row.escrow_id) &&
          getAddress(parsed.args.buyer) === row.owner_address) return entry.transactionHash.toLowerCase();
    }
    // A complete pass restarts at the first candidate block. An RPC relay may
    // index a historical event after an earlier empty scan; absence proves nothing.
    const next = end >= tip ? row.prepared_block : Number(end + 1n);
    withApprovalTable(db => db.prepare(`UPDATE customer_approval_intents SET scan_next_block = ?,
      updated_at = ? WHERE id = ?`).run(next, Math.floor(Date.now() / 1000), row.id));
    start = end + 1n;
  }
  return null;
}

export async function reconcileCustomerApproval(session: CustomerSession, origin: URL,
    id: string): Promise<ApprovalRecord> {
  const row = approvalRow(session, origin, id);
  const funding = fundingContext(session, origin, row.funding_id);
  const abi = pinnedEscrow(session, origin, funding);
  const network = networkConfigFromEnv(process.env);
  if (network.network !== "testnet") throw new Error("Approval reconciliation is testnet-only");
  await assertEvmRpcNetwork(network);
  const eventHash = row.state === "executed" && row.confirmed_hash ? row.confirmed_hash :
    await findApprovedHash(row, abi);
  if (eventHash) {
    withApprovalTable(db => db.transaction(() => {
      const current = db.prepare("SELECT observed_hash FROM customer_approval_intents WHERE id = ?")
        .get(id) as { observed_hash: string | null } | undefined;
      if (!current || (current.observed_hash && current.observed_hash !== eventHash)) {
        throw new Error("Approved event conflicts with the durable journal");
      }
      db.prepare(`UPDATE customer_approval_intents SET observed_hash = ?,
        state = CASE WHEN transaction_hash IS NOT NULL AND transaction_hash != ? AND state != 'executed'
          THEN 'conflict' ELSE state END, updated_at = ? WHERE id = ?`)
        .run(eventHash, eventHash, Math.floor(Date.now() / 1000), id);
    }).immediate());
  }
  const hash = eventHash ?? row.confirmed_hash ?? row.observed_hash ?? row.transaction_hash;
  if (!hash) return asRecord(approvalRow(session, origin, id));
  const [txRaw, receiptRaw] = await Promise.all([
    rpc("eth_getTransactionByHash", [hash]), rpc("eth_getTransactionReceipt", [hash]),
  ]);
  if (!txRaw || !receiptRaw || typeof txRaw !== "object" || typeof receiptRaw !== "object") {
    return asRecord(approvalRow(session, origin, id));
  }
  const tx = txRaw as Record<string, unknown>;
  const receipt = receiptRaw as Record<string, unknown>;
  const intended = JSON.parse(row.transaction_json) as WalletTransaction;
  if (typeof tx.from !== "string" || getAddress(tx.from) !== row.owner_address ||
      typeof tx.to !== "string" || getAddress(tx.to) !== getAddress(row.contract_address) ||
      typeof tx.input !== "string" || tx.input.toLowerCase() !== intended.data.toLowerCase() ||
      quantity(tx.value, "approval value") !== 0n || String(tx.hash).toLowerCase() !== hash) {
    return withApprovalTable(db => {
      db.prepare(`UPDATE customer_approval_intents SET state = 'conflict', updated_at = ?
        WHERE id = ? AND state != 'executed' AND wallet_attempt_id IS ? AND transaction_hash IS ?`)
          .run(Math.floor(Date.now() / 1000), id, row.wallet_attempt_id, row.transaction_hash);
      return asRecord(approvalRow(session, origin, id));
    });
  }
  const status = quantity(receipt.status, "approval receipt status");
  const mirrorResponse = await fetch(`${network.mirrorBaseUrl}/api/v1/contracts/results/${hash}`, {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" } });
  if (mirrorResponse.status === 404) return asRecord(approvalRow(session, origin, id));
  if (!mirrorResponse.ok) throw new Error("Mirror approval receipt is unavailable");
  const mirror = await boundedJson(mirrorResponse) as Record<string, unknown>;
  if (!mirror || mirror.contract_id !== row.contract_id) throw new Error("Mirror approval contract ID differs");
  assertRefundReceiptHashes(hash, receipt.transactionHash, mirror.hash);
  if (status !== 1n || mirror.result !== "SUCCESS") {
    if (status === 0n && typeof mirror.result === "string" && /^[A-Z][A-Z0-9_]+$/.test(mirror.result) &&
        !["SUCCESS", "UNKNOWN", "PENDING"].includes(mirror.result)) {
      return withApprovalTable(db => {
        db.prepare(`UPDATE customer_approval_intents SET state = ?, updated_at = ?
          WHERE id = ? AND state != 'executed' AND wallet_attempt_id IS ? AND transaction_hash IS ?`)
          .run(eventHash ? "conflict" : "failed", Math.floor(Date.now() / 1000), id, row.wallet_attempt_id, row.transaction_hash);
        return asRecord(approvalRow(session, origin, id));
      });
    }
    throw new Error("RPC and Mirror disagree about approval execution");
  }
  if (!Array.isArray(receipt.logs)) throw new Error("Approval receipt has no logs");
  const matches = receipt.logs.flatMap(raw => {
    if (!raw || typeof raw !== "object") return [];
    const log = raw as { address?: unknown; topics?: unknown; data?: unknown };
    if (typeof log.address !== "string" || getAddress(log.address) !== getAddress(row.contract_address) ||
        !Array.isArray(log.topics) || typeof log.data !== "string") return [];
    try {
      const parsed = abi.parseLog({ topics: log.topics as string[], data: log.data });
      return parsed?.name === "Approved" ? [parsed] : [];
    } catch { return []; }
  });
  if (matches.length !== 1 || BigInt(matches[0].args.id) !== BigInt(row.escrow_id) ||
      getAddress(matches[0].args.buyer) !== row.owner_address) {
    throw new Error("Approval receipt does not have exactly one matching Approved event");
  }
  const storageRaw = bytes(await rpc("eth_call", [{ to: row.contract_address,
    data: abi.encodeFunctionData("escrows", [BigInt(row.escrow_id)]) }, "latest"]), "approval storage");
  const storage = abi.decodeFunctionResult("escrows", storageRaw);
  if (getAddress(storage.buyer) !== row.owner_address ||
      getAddress(storage.seller) !== getAddress(funding.seller_address) ||
      BigInt(storage.amount) !== BigInt(funding.amount_tinybar) ||
      BigInt(storage.quoteExpiresAt) !== BigInt(funding.quote_expires_at) ||
      BigInt(storage.refundAfter) !== BigInt(funding.refund_after) ||
      String(storage.termsHash).toLowerCase() !== funding.terms_hash.toLowerCase() ||
      ![2n, 3n, 4n].includes(BigInt(storage.state))) {
    throw new Error("Escrow storage does not confirm the same buyer approval or later state");
  }
  return withApprovalTable(db => db.transaction(() => {
    const current = db.prepare("SELECT confirmed_hash FROM customer_approval_intents WHERE id = ?")
      .get(id) as { confirmed_hash: string | null } | undefined;
    if (!current || (current.confirmed_hash && current.confirmed_hash !== hash)) {
      throw new Error("Approval journal changed while reconciling");
    }
    db.prepare(`UPDATE customer_approval_intents SET state = ?, confirmed_hash = ?, updated_at = ?
      WHERE id = ?`).run("executed",
        hash, Math.floor(Date.now() / 1000), id);
    return asRecord(approvalRow(session, origin, id));
  }).immediate());
}
