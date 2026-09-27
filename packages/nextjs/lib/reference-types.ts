import { getAddress, Interface, ZeroAddress } from "ethers";

export const referenceRevision = "13ab01d70ac42531065094a52cd595ef7b6d3223";
export const referenceKinds = ["create", "token-approve", "deposit", "approve-release", "refund"] as const;
export type ReferenceKind = typeof referenceKinds[number];
export type ReferenceConfig = {
  enabled: true; network: "testnet"; chainId: 296; sourceRevision: string;
  service: { name: string; filename: string; bytes: number; sha256: string; priceBaseUnits: string;
    currency: string; tokenAddress: string; tokenDecimals: number; tokenSymbol: string; sellerAddress: string };
  escrowAddress: string; limits: { refundAfterSeconds: number }; identityNote: string;
};
export type ReferenceWalletAction = { kind: ReferenceKind; label: string; chainId: 296;
  to: string; data: string; value: "0x0"; nonce?: string };
export type ReferenceMessage = { kind: string; topicId: string; sequenceNumber: string; transactionId: string;
  sha256: string; mirrorVerified: boolean; senderAddress: string; payload: Record<string, unknown> };
export type ReferenceSession = {
  id: string; buyerAddress: string; customerSessionId: string; state: string; message: string;
  createdAt: number; deadline: number; escrowId?: string; releaseId?: string; agreementHash: string;
  evidenceHash?: string; delivery?: { filename: string; bytes: number; sha256: string; downloadPath: string };
  messages: ReferenceMessage[]; transactions: { kind: string; transactionHash: string; status: string }[];
  walletActions: ReferenceWalletAction[];
  pendingIntent?: { id: string; kind: ReferenceKind; status: string; transactionHash?: string;
    transaction: ReferenceWalletAction };
};

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uintPattern = /^(0|[1-9][0-9]{0,77})$/;
const shaPattern = /^(?:0x)?[a-fA-F0-9]{64}$/;
const hashPattern = /^0x[a-fA-F0-9]{64}$/;
const escrowABI = new Interface([
  "function createEscrow(address buyer,address seller,address arbiter,address token,uint64 threshold,bytes32 agreementHash,uint64 timeout)",
  "function deposit(uint256 escrowId,uint256 amount)", "function approveRelease(uint256 escrowId,uint256 releaseId)",
  "function claimRefund(uint256 escrowId)",
]);
const tokenABI = new Interface(["function approve(address spender,uint256 amount)"]);
function fail(): never { throw new Error("Reference bridge returned invalid or mismatched data"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, limit = 256): string {
  if (typeof value !== "string" || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) return fail();
  return value;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) return fail();
  return value as number;
}
function address(value: unknown): string {
  const checked = getAddress(text(value, 42));
  if (checked === ZeroAddress) return fail();
  return checked;
}
function uint(value: unknown): string {
  const checked = text(value, 78);
  if (!uintPattern.test(checked) || BigInt(checked) >= 1n << 256n) return fail();
  return checked;
}
function hash(value: unknown, prefix = true): string {
  const checked = text(value, 66);
  if (!(prefix ? hashPattern : shaPattern).test(checked)) return fail();
  return checked;
}
export function referenceId(value: unknown): string {
  const checked = text(value, 36);
  if (!idPattern.test(checked)) return fail();
  return checked;
}
export function referenceKind(value: unknown): ReferenceKind {
  if (!referenceKinds.includes(value as ReferenceKind)) return fail();
  return value as ReferenceKind;
}
export function referenceWalletFailure(error: unknown): string {
  if (!error || typeof error !== "object") return "The operation did not complete. Refresh before retrying.";
  const details = error as { code?: unknown; message?: unknown };
  if (details.code === 4001) return "This wallet request was rejected. Any earlier submitted transaction still needs reconciliation.";
  const message = typeof details.message === "string" ? details.message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 320).trim() : "";
  const code = Number.isSafeInteger(details.code) ? `Wallet error ${details.code}: ` : "";
  return message ? `${code}${message}` : `${code}The operation did not complete. Refresh before retrying.`;
}
function transactionNonce(value: unknown): string {
  const checked = text(value, 18);
  if (!/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/.test(checked)) return fail();
  return checked;
}
function array(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) return fail();
  return value;
}

export function parseReferenceConfig(value: unknown): ReferenceConfig {
  const row = object(value), service = object(row.service), limits = object(row.limits);
  if (row.enabled !== true || row.network !== "testnet" || row.chainId !== 296 || row.sourceRevision !== referenceRevision) return fail();
  const priceBaseUnits = uint(service.priceBaseUnits);
  if (BigInt(priceBaseUnits) <= 0n) return fail();
  const tokenAddress = address(service.tokenAddress);
  const currency = text(service.currency, 96);
  if (currency.toLowerCase() !== `eip155:296/erc20:${tokenAddress}`.toLowerCase()) return fail();
  return { enabled: true, network: "testnet", chainId: 296, sourceRevision: referenceRevision,
    service: { name: text(service.name), filename: text(service.filename), bytes: integer(service.bytes, 1, 32 * 1024 * 1024),
      sha256: hash(service.sha256, false), priceBaseUnits, currency,
      tokenAddress, tokenDecimals: integer(service.tokenDecimals, 0, 36), tokenSymbol: text(service.tokenSymbol, 32),
      sellerAddress: address(service.sellerAddress) }, escrowAddress: address(row.escrowAddress),
    limits: { refundAfterSeconds: integer(limits.refundAfterSeconds, 60, 604800) }, identityNote: text(row.identityNote, 1024) };
}

function walletAction(value: unknown): ReferenceWalletAction {
  const row = object(value);
  if (row.chainId !== 296 || row.value !== "0x0") return fail();
  const data = text(row.data, 2048);
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(data)) return fail();
  return { kind: referenceKind(row.kind), label: text(row.label), chainId: 296, to: address(row.to), data, value: "0x0",
    ...(row.nonce === undefined ? {} : { nonce: transactionNonce(row.nonce) }) };
}

export function validateReferenceTransaction(action: ReferenceWalletAction, session: ReferenceSession,
    config: ReferenceConfig): void {
  if (action.nonce !== undefined) transactionNonce(action.nonce);
  let target = config.escrowAddress, data: string;
  switch (action.kind) {
    case "create":
      data = escrowABI.encodeFunctionData("createEscrow", [session.buyerAddress, config.service.sellerAddress,
        ZeroAddress, config.service.tokenAddress, 1, session.agreementHash, session.deadline]);
      break;
    case "token-approve":
      target = config.service.tokenAddress;
      data = tokenABI.encodeFunctionData("approve", [config.escrowAddress, config.service.priceBaseUnits]);
      break;
    case "deposit":
      if (session.escrowId === undefined) return fail();
      data = escrowABI.encodeFunctionData("deposit", [session.escrowId, config.service.priceBaseUnits]);
      break;
    case "approve-release":
      if (session.escrowId === undefined || session.releaseId === undefined || !session.delivery || !session.evidenceHash) return fail();
      data = escrowABI.encodeFunctionData("approveRelease", [session.escrowId, session.releaseId]);
      break;
    case "refund":
      if (session.escrowId === undefined) return fail();
      data = escrowABI.encodeFunctionData("claimRefund", [session.escrowId]);
      break;
  }
  if (action.chainId !== 296 || action.value !== "0x0" || action.to.toLowerCase() !== target.toLowerCase() ||
      action.data.toLowerCase() !== data.toLowerCase()) return fail();
}

export function parseReferenceSession(value: unknown, config: ReferenceConfig,
    expectedBuyer: string, expectedId?: string): ReferenceSession {
  const row = object(value);
  const id = referenceId(row.id), buyerAddress = address(row.buyerAddress);
  if ((expectedId && id !== expectedId) || buyerAddress.toLowerCase() !== expectedBuyer.toLowerCase()) return fail();
  const customerSessionId = text(row.customerSessionId, 32);
  if (!/^[a-f0-9]{32}$/.test(customerSessionId)) return fail();
  const state = text(row.state, 32);
  if (!["negotiating", "agreed", "escrow-created", "token-approved", "funded", "delivered", "invoiced", "approved", "paid", "refunded", "uncertain", "failed"].includes(state)) return fail();
  const session: ReferenceSession = { id, buyerAddress, customerSessionId, state, message: text(row.message, 512),
    createdAt: integer(row.createdAt, 1), deadline: integer(row.deadline, 1),
    agreementHash: row.agreementHash === "" && ["negotiating", "uncertain", "failed"].includes(state) ? "" : hash(row.agreementHash),
    messages: array(row.messages ?? [], 32).map(value => {
      const item = object(value), topicId = text(item.topicId, 40), sequenceNumber = uint(item.sequenceNumber);
      if (!/^0\.0\.[1-9][0-9]{0,18}$/.test(topicId) || typeof item.mirrorVerified !== "boolean" ||
          (item.mirrorVerified && BigInt(sequenceNumber) < 1n)) return fail();
      return { kind: text(item.kind, 64), topicId, sequenceNumber, transactionId: text(item.transactionId, 100),
        sha256: hash(item.sha256, false), mirrorVerified: item.mirrorVerified, senderAddress: address(item.senderAddress),
        payload: object(item.payload) };
    }), transactions: array(row.transactions ?? [], 32).map(value => {
      const item = object(value);
      return { kind: text(item.kind, 64), transactionHash: hash(item.transactionHash), status: text(item.status, 32) };
    }), walletActions: array(row.walletActions ?? [], 5).map(walletAction) };
  if (row.escrowId !== undefined && row.escrowId !== null && row.escrowId !== "") session.escrowId = uint(row.escrowId);
  if (row.releaseId !== undefined && row.releaseId !== null && row.releaseId !== "") session.releaseId = uint(row.releaseId);
  if (row.evidenceHash) session.evidenceHash = hash(row.evidenceHash);
  if (row.delivery) {
    const delivered = object(row.delivery), bytes = integer(delivered.bytes, 1, 32 * 1024 * 1024), sha256 = hash(delivered.sha256, false);
    if (bytes !== config.service.bytes || sha256.replace(/^0x/, "").toLowerCase() !== config.service.sha256.replace(/^0x/, "").toLowerCase()) return fail();
    session.delivery = { filename: text(delivered.filename), bytes, sha256, downloadPath: `/api/reference/sessions/${id}/file` };
  }
  if (row.pendingIntent) {
    const pending = object(row.pendingIntent);
    session.pendingIntent = { id: referenceId(pending.id), kind: referenceKind(pending.kind), status: text(pending.status, 32),
      transaction: walletAction(pending.transaction) };
    if (pending.transactionHash) session.pendingIntent.transactionHash = hash(pending.transactionHash);
    if (session.pendingIntent.kind !== session.pendingIntent.transaction.kind) return fail();
    validateReferenceTransaction(session.pendingIntent.transaction, session, config);
  }
  for (const action of session.walletActions) validateReferenceTransaction(action, session, config);
  return session;
}
