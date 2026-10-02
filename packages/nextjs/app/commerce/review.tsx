"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { SellerQuote } from "@neuron/hedera";
import { InjectedWalletPicker } from "../wallet/picker";
import { assertInjectedWallet, selectedInjectedWallet, type WalletProvider } from "../wallet/injected";

type Intent = {
  id: string; state: "quoted" | "reviewed"; quoteTopic: string; quoteSequence: number;
  termsHash: string; terms: SellerQuote; reviewMessage: string; reviewBy: number;
  reviewedAt: number | null;
};
type Seller = {
  network: "testnet"; chainId: 296; buyerAddress: string; sessionId: string; sessionExpiresAt: number;
  sellerAccount: string; quoteTopic: string; serviceId: string; maxSpendTinybar: string;
  escrowContractId: string; escrowAddress: string;
};
type Funding = {
  walletAttemptId?: string | null;
  id: string; quoteIntentId: string; state: "prepared" | "submitted" | "executed" | "failed" | "conflict" | "abandoned";
  contractState: "funded" | "approved" | "paid" | "refunded" | null;
  transactionHash: string | null; reportedHash: string | null; observedHash: string | null;
  escrowId: string | null; termsHash: string;
  contractId: string; contractAddress: string; sellerAccountId: string | null; sellerAddress: string;
  amountTinybar: string; quoteExpiresAt: number; refundAfter: number; preparedAt: number;
  walletOpenedAt: number | null; runtimeSha256: string | null; abiPinned: boolean;
  abandonedAt: number | null;
  settlementHash: string | null; settlementMirrorTimestamp: string | null;
  settlementRecipientAddress: string | null; settlementAmountTinybar: string | null;
  settlementVerifiedAt: number | null;
};
type WalletTransaction = {
  from: string; to: string; value: string; data: string; gas: string; gasPrice: string; chainId: "0x128"; nonce?: string;
};
type Refund = {
  walletAttemptId?: string | null;
  id: string; fundingId: string; state: Funding["state"]; escrowId: string;
  transactionHash: string | null; reportedHash: string | null; observedHash: string | null;
  amountTinybar: string; preparedAt: number;
  walletOpenedAt: number | null; walletOpenCount: number;
};
type Approval = {
  walletAttemptId?: string | null;
  id: string; fundingId: string;
  state: "prepared" | "wallet-opened" | "submitted" | "executed" | "failed" | "conflict";
  escrowId: string; transactionHash: string | null; reportedHash: string | null;
  observedHash: string | null; requestTopic: string; requestSequence: number;
  transportBytes: number; transportOpenedAt: string; transportClosedAt: string;
  preparedAt: number; acknowledgedAt: number | null;
};

function hbar(tinybar: string): string {
  const value = BigInt(tinybar);
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} HBAR`;
}

export default function CommerceClient({ network }: { network: "testnet" | "mainnet" }) {
  const [status, setStatus] = useState<"loading" | "disabled" | "signIn" | "ready" | "error">(
    network === "testnet" ? "loading" : "disabled");
  const [seller, setSeller] = useState<Seller | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [sequence, setSequence] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [funding, setFunding] = useState<Funding | null>(null);
  const [fundingHistory, setFundingHistory] = useState<Funding[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyPage, setHistoryPage] = useState(0);
  const [selectedFundingId, setSelectedFundingId] = useState<string | null>(null);
  const [fundingEnabled, setFundingEnabled] = useState(false);
  const [fundingTx, setFundingTx] = useState<WalletTransaction | null>(null);
  const [fundingMessage, setFundingMessage] = useState("");
  const [fundingBusy, setFundingBusy] = useState(false);
  const [reconciliation, setReconciliation] = useState<"current" | "unavailable" | null>(null);
  const [recoveredFundingHash, setRecoveredFundingHash] = useState("");
  const [recoveredRefundHash, setRecoveredRefundHash] = useState("");
  const [recoveredApprovalHash, setRecoveredApprovalHash] = useState("");
  const [pendingHash, setPendingHash] = useState<string | null>(null);
  const [fundingRetryConsent, setFundingRetryConsent] = useState<{ attemptId: string | null; accepted: boolean }>(
    { attemptId: null, accepted: false });
  const [refund, setRefund] = useState<Refund | null>(null);
  const [refundTx, setRefundTx] = useState<WalletTransaction | null>(null);
  const [refundBusy, setRefundBusy] = useState(false);
  const [refundMessage, setRefundMessage] = useState("");
  const [refundReconciliation, setRefundReconciliation] = useState<"current" | "unavailable" | null>(null);
  const [pendingRefundHash, setPendingRefundHash] = useState<string | null>(null);
  const [refundRetryConsent, setRefundRetryConsent] = useState<{ id: string | null; accepted: boolean }>(
    { id: null, accepted: false });
  const [approval, setApproval] = useState<Approval | null>(null);
  const [approvalEnabled, setApprovalEnabled] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalMessage, setApprovalMessage] = useState("");
  const [approvalReconciliation, setApprovalReconciliation] = useState<"current" | "unavailable" | null>(null);
  const [pendingApprovalHash, setPendingApprovalHash] = useState<string | null>(null);
  const [approvalTransportConsent, setApprovalTransportConsent] = useState<{
    id: string | null; accepted: boolean }>({ id: null, accepted: false });
  const fundingRead = useRef(0);
  const refundRead = useRef(0);
  const approvalRead = useRef(0);
  const walletActionBusy = fundingBusy || refundBusy || approvalBusy;
  const invalidateReads = useCallback(() => {
    fundingRead.current++;
    refundRead.current++;
    approvalRead.current++;
  }, []);
  useEffect(() => () => invalidateReads(), [invalidateReads]);

  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const refundRetryAccepted = refundRetryConsent.id === refund?.id && refundRetryConsent.accepted;
  const approvalTransportAcknowledged = approvalTransportConsent.id === approval?.id &&
    approvalTransportConsent.accepted;
  const fundingId = funding?.id ?? null;
  const fundingRetryAccepted = fundingRetryConsent.attemptId === funding?.walletAttemptId &&
    fundingRetryConsent.accepted;
  const fundingRetryAvailable = Boolean(funding && funding.state === "prepared" &&
    funding.walletAttemptId && funding.walletOpenedAt !== null && funding.runtimeSha256 && funding.abiPinned &&
    funding.abandonedAt === null && !funding.reportedHash && !funding.observedHash && !funding.escrowId && !pendingHash &&
    nowSeconds >= funding.walletOpenedAt + 60 && nowSeconds + 120 < funding.quoteExpiresAt &&
    reconciliation === "current" && fundingEnabled);

  useEffect(() => {
    const timer = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(timer);
  }, []);

  const sellerQuoteExpired = Boolean(intent && (nowSeconds === 0 ||
    nowSeconds >= Number(intent.terms.expiresAt)));
  const reviewExpired = Boolean(intent && intent.state === "quoted" &&
    (sellerQuoteExpired || nowSeconds >= intent.reviewBy));

  const refreshFunding = useCallback(async () => {
    if (network !== "testnet") return;
    const generation = ++fundingRead.current;
    const query = new URLSearchParams({ page: String(historyPage) });
    if (selectedFundingId) query.set("id", selectedFundingId);
    const response = await fetch(`/api/customer-funding?${query}`, { cache: "no-store" }).catch(() => null);
    if (!response?.ok) {
      if (generation !== fundingRead.current) return;
      setReconciliation("unavailable");
      if (response?.status === 401) setStatus("signIn");
      return;
    }
    const body = await response.json().catch(() => null) as { funding?: Funding | null; fundingEnabled?: boolean;
      reconciliation?: "current" | "unavailable"; history?: { records: Funding[]; hasMore: boolean } } | null;
    if (generation !== fundingRead.current) return;
    if (!body) { setReconciliation("unavailable"); return; }
    setFunding(body.funding ?? null);
    setFundingHistory(body.history?.records ?? []);
    setHistoryHasMore(body.history?.hasMore === true);
    setFundingEnabled(body.fundingEnabled === true);
    setReconciliation(body.reconciliation ?? null);
    if (body.reconciliation === "current" && body.funding &&
        ["executed", "failed", "conflict", "abandoned"].includes(body.funding.state)) setFundingMessage("");
    if (body.funding && !body.funding.transactionHash) {
      const saved = window.sessionStorage.getItem(`neuron-funding-hash:${body.funding.id}`);
      if (saved && /^0x[0-9a-fA-F]{64}$/.test(saved)) setPendingHash(saved);
    }
  }, [network, historyPage, selectedFundingId]);

  useEffect(() => {
    const reads = fundingRead;
    const timer = setTimeout(() => { void refreshFunding(); }, 0);
    return () => { clearTimeout(timer); reads.current++; };
  }, [refreshFunding]);

  const refreshRefund = useCallback(async () => {
    if (network !== "testnet") return;
    const generation = ++refundRead.current;
    if (!fundingId) { setRefund(null); return; }
    const response = await fetch(`/api/customer-refund?fundingId=${encodeURIComponent(fundingId)}`,
      { cache: "no-store" }).catch(() => null);
    if (!response?.ok) {
      if (generation !== refundRead.current) return;
      setRefundReconciliation("unavailable");
      if (response?.status === 401) setStatus("signIn");
      return;
    }
    const body = await response.json().catch(() => null) as { refund?: Refund | null;
      reconciliation?: "current" | "unavailable" } | null;
    if (generation !== refundRead.current) return;
    if (!body) { setRefundReconciliation("unavailable"); return; }
    setRefund(body.refund ?? null);
    setRefundReconciliation(body.reconciliation ?? null);
    if (body.reconciliation === "current" && body.refund &&
        ["executed", "failed", "conflict", "abandoned"].includes(body.refund.state)) setRefundMessage("");
    if (body.refund && !body.refund.transactionHash) {
      const saved = window.sessionStorage.getItem(`neuron-refund-hash:${body.refund.id}`);
      if (saved && /^0x[0-9a-fA-F]{64}$/.test(saved)) setPendingRefundHash(saved);
    }
  }, [network, fundingId]);

  useEffect(() => {
    const reads = refundRead;
    const timer = setTimeout(() => { void refreshRefund(); }, 0);
    return () => { clearTimeout(timer); reads.current++; };
  }, [refreshRefund]);

  const refreshApproval = useCallback(async () => {
    if (network !== "testnet") return;
    const generation = ++approvalRead.current;
    if (!fundingId) { setApproval(null); return; }
    const response = await fetch(`/api/customer-approval?fundingId=${encodeURIComponent(fundingId)}`,
      { cache: "no-store" }).catch(() => null);
    if (!response?.ok) {
      if (generation !== approvalRead.current) return;
      setApprovalReconciliation("unavailable");
      if (response?.status === 401) setStatus("signIn");
      return;
    }
    const body = await response.json().catch(() => null) as { approval?: Approval | null; approvalEnabled?: boolean;
      reconciliation?: "current" | "unavailable" } | null;
    if (generation !== approvalRead.current) return;
    if (!body) { setApprovalReconciliation("unavailable"); return; }
    setApproval(body.approval ?? null);
    setApprovalEnabled(body.approvalEnabled === true);
    setApprovalReconciliation(body.reconciliation ?? null);
    if (body.reconciliation === "current" && body.approval &&
        ["executed", "failed", "conflict"].includes(body.approval.state)) setApprovalMessage("");
    if (body.approval && !body.approval.reportedHash) {
      const saved = window.sessionStorage.getItem(`neuron-approval-hash:${body.approval.id}`);
      if (saved && /^0x[0-9a-fA-F]{64}$/.test(saved)) setPendingApprovalHash(saved);
    }
  }, [network, fundingId]);

  useEffect(() => {
    const reads = approvalRead;
    const timer = setTimeout(() => { void refreshApproval(); }, 0);
    return () => { clearTimeout(timer); reads.current++; };
  }, [refreshApproval]);

  useEffect(() => {
    if (network !== "testnet") return;
    let live = true;
    fetch("/api/customer-commerce", { cache: "no-store" }).then(async response => {
      if (!live) return;
      if (response.status === 404) { setStatus("disabled"); return; }
      if (response.status === 401) { setStatus("signIn"); return; }
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { error?: unknown } | null;
        if (live) {
          setMessage(typeof failure?.error === "string" ? failure.error :
            "Quote review configuration or customer session is unavailable.");
          setStatus("error");
        }
        return;
      }
      const body = await response.json() as { seller?: Seller; intent?: Intent | null };
      if (!live) return;
      if (!body.seller || typeof body.seller.quoteTopic !== "string") { setStatus("error"); return; }
      setSeller(body.seller);
      setIntent(body.intent ?? null);
      setStatus("ready");
    }).catch(() => { if (live) setStatus("error"); });
    return () => { live = false; };
  }, [network]);

  async function inspect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !/^[1-9]\d{0,14}$/.test(sequence)) {
      setMessage("Enter a positive final HCS sequence number supplied by the seller.");
      return;
    }
    setBusy(true);
    setMessage("Checking the seller's signed HCS quote and current account key.");
    try {
      const response = await fetch("/api/customer-commerce", { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "inspect", sequenceNumber: Number(sequence) }) });
      const body = await response.json() as { intent?: Intent; error?: string };
      if (!response.ok || !body.intent) throw new Error(body.error ?? "Seller quote could not be verified");
      setIntent(body.intent);
      setMessage("Signed quote verified for this wallet and session. Review the terms before signing.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Seller quote could not be verified");
    } finally { setBusy(false); }
  }

  async function review() {
    if (!intent || intent.state !== "quoted" || busy || reviewExpired) return;
    setBusy(true);
    setMessage("Checking wallet and exact testnet quote terms.");
    try {
      const { provider, revision } = selectedInjectedWallet();
      const chain = await provider.request({ method: "eth_chainId" });
      if (typeof chain !== "string" || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== 296n) {
        throw new Error("Switch your wallet to Hedera testnet (chain 296)");
      }
      const accounts = await provider.request({ method: "eth_accounts" });
      if (!Array.isArray(accounts) || typeof accounts[0] !== "string" ||
          accounts[0].toLowerCase() !== intent.terms.buyerAddress.toLowerCase()) {
        throw new Error("The signed-in buyer wallet must be selected in your wallet extension");
      }
      assertInjectedWallet(provider, revision);
      setMessage("Approve the review message in your wallet. This does not transfer HBAR.");
      const signature = await provider.request({ method: "personal_sign",
        params: [intent.reviewMessage, intent.terms.buyerAddress] });
      if (typeof signature !== "string") throw new Error("Wallet did not return a review signature");
      assertInjectedWallet(provider, revision);
      const response = await fetch("/api/customer-commerce", { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "review", intentId: intent.id, signature }) });
      const body = await response.json() as { intent?: Intent; error?: string };
      if (!response.ok || !body.intent) throw new Error(body.error ?? "Quote review was rejected");
      setIntent(body.intent);
      setMessage("Quote review recorded. No HBAR was transferred and no seller withdrawal was approved.");
      void refreshFunding();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Quote review failed");
    } finally { setBusy(false); }
  }

  async function prepareFunding() {
    if (!intent || intent.state !== "reviewed" || funding?.quoteIntentId === intent.id ||
        !fundingEnabled || fundingBusy || sellerQuoteExpired) return;
    invalidateReads();
    setFundingBusy(true);
    setFundingMessage("Rechecking the signed quote, deployed escrow code, expiration, balance and fee cap.");
    try {
      const response = await fetch("/api/customer-funding", { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "prepare", quoteIntentId: intent.id }) });
      const body = await response.json() as { funding?: Funding; transaction?: WalletTransaction; error?: string };
      if (!response.ok || !body.funding || !body.transaction) {
        throw new Error(body.error ?? "Funding preflight did not produce an exact wallet transaction");
      }
      setFunding(body.funding);
      setSelectedFundingId(body.funding.id);
      setHistoryPage(0);
      setFundingTx(body.transaction);
      setFundingMessage("Funding intent recorded. Check the exact amount and contract before opening your wallet.");
    } catch (error) {
      setFundingMessage(error instanceof Error ? error.message : "Funding preflight failed");
      await refreshFunding();
    } finally { setFundingBusy(false); }
  }

  async function recordFundingHash(id: string, hash: string, walletAttemptId?: string | null) {
    const attempt = walletAttemptId ?? window.sessionStorage.getItem(`neuron-funding-attempt:${id}`);
    if (attempt) window.sessionStorage.setItem(`neuron-funding-attempt:${id}`, attempt);
    window.sessionStorage.setItem(`neuron-funding-hash:${id}`, hash);
    setPendingHash(hash);
    const response = await fetch("/api/customer-funding", { method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "attach", fundingId: id, transactionHash: hash, ...(attempt ? { walletAttemptId: attempt } : {}) }) });
    const body = await response.json() as { funding?: Funding; error?: string };
    if (!response.ok || !body.funding) throw new Error(body.error ?? "Transaction hash could not be saved");
    setFunding(body.funding);
    setFundingTx(null);
    window.sessionStorage.removeItem(`neuron-funding-hash:${id}`);
    window.sessionStorage.removeItem(`neuron-funding-attempt:${id}`);
    setPendingHash(null);
    setFundingMessage("Wallet returned a transaction hash. Awaiting RPC receipt and Mirror confirmation.");
  }

  async function recoverWalletHash(kind: "funding" | "refund" | "approval", id: string,
      hash: string, attemptId?: string | null) {
    if (walletActionBusy || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return;
    const setPending = kind === "funding" ? setFundingBusy : kind === "refund" ? setRefundBusy : setApprovalBusy;
    const setMessage = kind === "funding" ? setFundingMessage : kind === "refund" ? setRefundMessage : setApprovalMessage;
    invalidateReads();
    setPending(true);
    try {
      if (kind === "funding") { await recordFundingHash(id, hash, attemptId); await refreshFunding(); }
      else if (kind === "refund") { await recordRefundHash(id, hash, attemptId); await refreshRefund(); }
      else { await recordApprovalHash(id, hash, attemptId); await refreshApproval(); }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Wallet hash recovery is unavailable");
    } finally { setPending(false); }
  }

  async function currentBuyerWallet(provider: WalletProvider, revision: number): Promise<string> {
    const sessionResponse = await fetch("/api/customer-auth/session", { cache: "no-store" });
    if (!sessionResponse.ok) throw new Error("Sign in again with the original buyer wallet");
    const current = await sessionResponse.json() as { ownerAddress?: string };
    if (!current.ownerAddress || !/^0x[0-9a-fA-F]{40}$/.test(current.ownerAddress)) {
      throw new Error("Customer buyer session is unavailable");
    }
    const chain = await provider.request({ method: "eth_chainId" });
    if (typeof chain !== "string" || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== 296n) {
      throw new Error("Switch your wallet to Hedera testnet (chain 296)");
    }
    const accounts = await provider.request({ method: "eth_accounts" });
    if (!Array.isArray(accounts) || typeof accounts[0] !== "string" ||
        accounts[0].toLowerCase() !== current.ownerAddress.toLowerCase()) {
      throw new Error("The original buyer wallet must be selected");
    }
    assertInjectedWallet(provider, revision);
    return current.ownerAddress;
  }

  async function sendFunding(retry = false) {
    if (!funding || funding.state !== "prepared" || walletActionBusy ||
        (retry ? !fundingRetryAvailable || !fundingRetryAccepted :
          funding.walletOpenedAt !== null || nowSeconds + 60 >= funding.quoteExpiresAt)) return;
    invalidateReads();
    setFundingBusy(true);
    setFundingMessage("Opening your wallet for the exact HBAR escrow transaction.");
    let submitted = false;
    let markerRequested = false;
    try {
      const { provider, revision } = selectedInjectedWallet();
      await currentBuyerWallet(provider, revision);
      markerRequested = true;
      const opened = await fetch("/api/customer-funding", { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: retry ? "retryWallet" : "openWallet", fundingId: funding.id,
          ...(retry ? { acknowledged: true } : {}) }) });
      const openedBody = await opened.json() as { funding?: Funding; transaction?: WalletTransaction; error?: string };
      if (!opened.ok || !openedBody.funding || !openedBody.transaction) {
        throw new Error(openedBody.error ?? "Fresh funding wallet preflight failed");
      }
      window.sessionStorage.setItem(`neuron-funding-attempt:${funding.id}`, openedBody.funding.walletAttemptId ?? "");
      setFunding(openedBody.funding);
      setFundingRetryConsent({ attemptId: null, accepted: false });
      setFundingTx(null); // A durable marker precedes any wallet submission.
      submitted = true;
      await currentBuyerWallet(provider, revision);
      const hash = await provider.request({ method: "eth_sendTransaction", params: [openedBody.transaction] });
      if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        throw new Error("Wallet did not return a valid transaction hash; funding outcome is uncertain");
      }
      await recordFundingHash(funding.id, hash, openedBody.funding.walletAttemptId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Wallet transaction failed";
      setFundingMessage(submitted || markerRequested ? `${reason}. Reconcile the funding intent before another wallet action.` :
        `${reason}. Select the correct wallet and try this prepared transaction again.`);
      void refreshFunding();
    } finally { setFundingBusy(false); }
  }

  async function retryHashSave() {
    if (!funding || !pendingHash || fundingBusy) return;
    invalidateReads();
    setFundingBusy(true);
    try { await recordFundingHash(funding.id, pendingHash); }
    catch (error) { setFundingMessage(error instanceof Error ? error.message : "Hash save is unavailable"); }
    finally { setFundingBusy(false); }
  }

  async function resolveExpiredFunding() {
    if (!funding || !["prepared", "failed"].includes(funding.state) || fundingBusy ||
        nowSeconds <= funding.quoteExpiresAt) return;
    invalidateReads();
    setFundingBusy(true);
    setFundingMessage("Checking the expired quote, unused on-chain terms and the complete funding event range.");
    try {
      const response = await fetch("/api/customer-funding", { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolveExpired", fundingId: funding.id }) });
      const body = await response.json() as { funding?: Funding; scanComplete?: boolean; error?: string };
      if (!response.ok || !body.funding) throw new Error(body.error ?? "Expired funding proof is unavailable");
      setFunding(body.funding);
      setFundingMessage(body.scanComplete ?
        "Quote expired, no funding found in the complete event range, and the terms remain unused on-chain." :
        "The bounded historical log scan is incomplete. Continue the proof later; do not send this quote again.");
    } catch (error) {
      setFundingMessage(error instanceof Error ? error.message : "Expired funding proof failed");
    } finally { setFundingBusy(false); }
  }

  async function prepareRefund() {
    if (!funding || funding.state !== "executed" || !funding.escrowId ||
        refund?.fundingId === funding.id || refundBusy ||
        nowSeconds < funding.refundAfter ||
        (funding.contractState !== "funded" && funding.contractState !== "approved")) return;
    invalidateReads();
    setRefundBusy(true);
    setRefundMessage("Checking the escrow's refund deadline, buyer, contract code and gas cap.");
    try {
      const response = await fetch("/api/customer-refund", { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "prepare", fundingId: funding.id }) });
      const body = await response.json() as { refund?: Refund; transaction?: WalletTransaction; error?: string };
      if (!response.ok || !body.refund || !body.transaction) {
        throw new Error(body.error ?? "Buyer refund could not be prepared");
      }
      setRefund(body.refund);
      setRefundTx(body.transaction);
      setRefundMessage("Refund intent recorded. Your wallet must approve the separate refund transaction.");
    } catch (error) {
      setRefundMessage(error instanceof Error ? error.message : "Buyer refund preflight failed");
      await refreshRefund();
    } finally { setRefundBusy(false); }
  }

  async function recordRefundHash(id: string, hash: string, walletAttemptId?: string | null) {
    const attempt = walletAttemptId ?? window.sessionStorage.getItem(`neuron-refund-attempt:${id}`);
    if (attempt) window.sessionStorage.setItem(`neuron-refund-attempt:${id}`, attempt);
    window.sessionStorage.setItem(`neuron-refund-hash:${id}`, hash);
    setPendingRefundHash(hash);
    const response = await fetch("/api/customer-refund", { method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "attach", refundId: id, transactionHash: hash, ...(attempt ? { walletAttemptId: attempt } : {}) }) });
    const body = await response.json() as { refund?: Refund; error?: string };
    if (!response.ok || !body.refund) throw new Error(body.error ?? "Refund hash could not be saved");
    setRefund(body.refund);
    setRefundTx(null);
    window.sessionStorage.removeItem(`neuron-refund-hash:${id}`);
    window.sessionStorage.removeItem(`neuron-refund-attempt:${id}`);
    setPendingRefundHash(null);
    setRefundMessage("Wallet returned a refund hash. Awaiting RPC receipt and Mirror confirmation.");
  }

  async function sendRefund() {
    if (!refund || !funding || refund.fundingId !== funding.id || refund.state !== "prepared" ||
        refund.walletOpenedAt !== null || refundBusy) return;
    invalidateReads();
    setRefundBusy(true);
    setRefundMessage("Opening your wallet for the buyer-only escrow refund.");
    let submitted = false;
    let markerRequested = false;
    try {
      const { provider, revision } = selectedInjectedWallet();
      await currentBuyerWallet(provider, revision);
      markerRequested = true;
      const opened = await fetch("/api/customer-refund", { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "openWallet", refundId: refund.id }) });
      const openedBody = await opened.json() as { refund?: Refund; transaction?: WalletTransaction; error?: string };
      if (!opened.ok || !openedBody.refund || !openedBody.transaction) {
        throw new Error(openedBody.error ?? "Fresh refund wallet preflight failed");
      }
      window.sessionStorage.setItem(`neuron-refund-attempt:${refund.id}`, openedBody.refund.walletAttemptId ?? "");
      setRefund(openedBody.refund);
      setRefundTx(null);
      submitted = true;
      await currentBuyerWallet(provider, revision);
      const hash = await provider.request({ method: "eth_sendTransaction", params: [openedBody.transaction] });
      if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        throw new Error("Wallet did not return a refund hash; outcome is uncertain");
      }
      await recordRefundHash(refund.id, hash, openedBody.refund.walletAttemptId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Refund transaction failed";
      setRefundMessage(submitted || markerRequested ? `${reason}. Reconcile the refund intent before another wallet action.` :
        `${reason}. Select the original buyer wallet and try this prepared refund again.`);
      void refreshRefund();
    } finally { setRefundBusy(false); }
  }

  async function retryRefundHashSave() {
    if (!refund || !pendingRefundHash || refundBusy) return;
    invalidateReads();
    setRefundBusy(true);
    try { await recordRefundHash(refund.id, pendingRefundHash); }
    catch (error) { setRefundMessage(error instanceof Error ? error.message : "Refund hash save is unavailable"); }
    finally { setRefundBusy(false); }
  }

  async function retryRefundWallet() {
    if (!refund || !funding || refund.fundingId !== funding.id || !refundRetryAccepted ||
        refundBusy || pendingRefundHash || !["prepared", "submitted", "failed"].includes(refund.state) ||
        refund.walletOpenedAt === null ||
        (refund.state !== "failed" && nowSeconds < refund.walletOpenedAt + 60) || refund.observedHash) return;
    invalidateReads();
    setRefundBusy(true);
    let markerRequested = false;
    try {
      const { provider, revision } = selectedInjectedWallet();
      await currentBuyerWallet(provider, revision);
      markerRequested = true;
      const response = await fetch("/api/customer-refund", { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retryWallet", refundId: refund.id, acknowledged: true }) });
      const body = await response.json() as { refund?: Refund; transaction?: WalletTransaction;
        warning?: string; error?: string };
      if (!response.ok || !body.refund || !body.transaction || !body.warning) {
        throw new Error(body.error ?? "Manual refund retry preflight was rejected");
      }
      setRefund(body.refund);
      setRefundTx(null);
      window.sessionStorage.setItem(`neuron-refund-attempt:${refund.id}`, body.refund.walletAttemptId ?? "");
      setRefundRetryConsent({ id: null, accepted: false });
      setRefundMessage(body.warning);
      await currentBuyerWallet(provider, revision);
      const hash = await provider.request({ method: "eth_sendTransaction", params: [body.transaction] });
      if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        throw new Error("Wallet returned no valid retry hash; outcome is uncertain");
      }
      await recordRefundHash(refund.id, hash, body.refund.walletAttemptId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Manual refund retry failed";
      setRefundMessage(markerRequested ? `${reason}. Reconcile the saved wallet attempts before requesting another guarded retry.` :
        reason);
      void refreshRefund();
    } finally { setRefundBusy(false); }
  }

  async function prepareApproval() {
    if (!funding || funding.state !== "executed" || funding.contractState !== "funded" ||
        !funding.escrowId || approval?.fundingId === funding.id || !approvalEnabled || approvalBusy ||
        nowSeconds + 120 >= funding.refundAfter) return;
    invalidateReads();
    setApprovalBusy(true);
    setApprovalMessage("Checking the confirmed request, completed transport bytes and exact funded escrow.");
    try {
      const response = await fetch("/api/customer-approval", { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "prepare", fundingId: funding.id }) });
      const body = await response.json() as { approval?: Approval; transaction?: WalletTransaction; error?: string };
      if (!response.ok || !body.approval || !body.transaction) {
        throw new Error(body.error ?? "Buyer approval preflight was rejected");
      }
      setApproval(body.approval);
      setApprovalMessage("Approval intent recorded. Inspect the transport evidence and choose a separate wallet approval.");
    } catch (error) {
      setApprovalMessage(error instanceof Error ? error.message : "Buyer approval is unavailable");
      await refreshApproval();
    } finally { setApprovalBusy(false); }
  }

  async function recordApprovalHash(id: string, hash: string, walletAttemptId?: string | null) {
    const attempt = walletAttemptId ?? window.sessionStorage.getItem(`neuron-approval-attempt:${id}`);
    if (attempt) window.sessionStorage.setItem(`neuron-approval-attempt:${id}`, attempt);
    window.sessionStorage.setItem(`neuron-approval-hash:${id}`, hash);
    setPendingApprovalHash(hash);
    const response = await fetch("/api/customer-approval", { method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "attach", approvalId: id, transactionHash: hash, ...(attempt ? { walletAttemptId: attempt } : {}) }) });
    const body = await response.json() as { approval?: Approval; error?: string };
    if (!response.ok || !body.approval) throw new Error(body.error ?? "Approval hash could not be saved");
    setApproval(body.approval);
    window.sessionStorage.removeItem(`neuron-approval-hash:${id}`);
    window.sessionStorage.removeItem(`neuron-approval-attempt:${id}`);
    setPendingApprovalHash(null);
    setApprovalMessage("Wallet returned an approval hash. Awaiting RPC, Mirror and escrow storage confirmation.");
  }

  async function sendApproval() {
    if (!approval || pendingApprovalHash || !approvalTransportAcknowledged || !["prepared", "wallet-opened", "submitted", "failed"].includes(approval.state) || approvalBusy ||
        !funding || approval.fundingId !== funding.id || nowSeconds + 120 >= funding.refundAfter) return;
    invalidateReads();
    setApprovalBusy(true);
    let walletOpened = false;
    let markerRequested = false;
    try {
      const { provider, revision } = selectedInjectedWallet();
      await currentBuyerWallet(provider, revision);
      // Persist this marker before opening the wallet. After it, a browser crash
      // cannot safely infer that the transaction was never broadcast.
      markerRequested = true;
      const mark = await fetch("/api/customer-approval", { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: approval.state === "prepared" ? "wallet-opened" : "retryWallet", approvalId: approval.id,
          acknowledged: true }) });
      const marked = await mark.json() as { approval?: Approval; transaction?: WalletTransaction; error?: string };
      if (!mark.ok || !marked.approval || !marked.transaction) {
        throw new Error(marked.error ?? "Approval wallet marker was not saved");
      }
      window.sessionStorage.setItem(`neuron-approval-attempt:${approval.id}`, marked.approval.walletAttemptId ?? "");
      setApproval(marked.approval);
      setApprovalTransportConsent({ id: null, accepted: false });
      walletOpened = true;
      await currentBuyerWallet(provider, revision);
      const hash = await provider.request({ method: "eth_sendTransaction", params: [marked.transaction] });
      if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        throw new Error("Wallet did not return a valid approval hash; outcome is uncertain");
      }
      await recordApprovalHash(approval.id, hash, marked.approval.walletAttemptId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Buyer approval failed";
      setApprovalMessage(walletOpened || markerRequested ? `${reason}. Reconcile the approval intent before another wallet action.` :
        `${reason}. Check the selected wallet before retrying this prepared intent.`);
      void refreshApproval();
    } finally { setApprovalBusy(false); }
  }

  async function retryApprovalHashSave() {
    if (!approval || !pendingApprovalHash || approvalBusy) return;
    invalidateReads();
    setApprovalBusy(true);
    try { await recordApprovalHash(approval.id, pendingApprovalHash); }
    catch (error) { setApprovalMessage(error instanceof Error ? error.message : "Approval hash save is unavailable"); }
    finally { setApprovalBusy(false); }
  }

  return <section>
    <p className="eyebrow">Hedera {network} · customer commerce</p>
    <h1>Review a seller quote</h1>
    <p>A seller must publish a signed quote to its real Hedera topic before there is a price to review. A directory fee, heartbeat, or payment schedule is not a quote.</p>
    {network === "testnet" && <InjectedWalletPicker />}
    <p className="notice">A quote review does not transfer HBAR. Funding locks HBAR in a buyer-controlled escrow. A separate opt-in approval can follow only after a confirmed seller request and completed positive-byte transport; that is transport evidence, not proof that the browser consumed useful data.</p>
    {status === "loading" && <p role="status">Checking quote review availability…</p>}
    {status === "disabled" && <p role="status">New signed quote review is unavailable on this network or deployment.{network === "testnet" && " Existing escrow records remain available below after buyer sign-in."}</p>}
    {status === "signIn" && <p role="status">Sign in with your Hedera testnet wallet on the <Link href="/sessions">testnet stream page</Link> before reviewing a quote.</p>}
    {status === "error" && <p role="alert">{message || "Quote review configuration or customer session is unavailable."}</p>}
    {status === "ready" && seller && <>
      <p>Configured seller <span className="mono">{seller.sellerAccount}</span>, service <span className="mono">{seller.serviceId}</span>, quote topic <span className="mono">{seller.quoteTopic}</span>. These settings alone do not verify a seller or establish a price.</p>
      {!intent && <p role="status">No verified seller-signed quote is attached to this customer session.</p>}
      <details>
        <summary>Details a seller needs to issue a quote for this session</summary>
        <dl className="details">
          <div><dt>Buyer wallet</dt><dd className="mono">{seller.buyerAddress}</dd></div>
          <div><dt>Session ID</dt><dd className="mono">{seller.sessionId}</dd></div>
          <div><dt>Session expires</dt><dd>{new Date(seller.sessionExpiresAt * 1000).toLocaleString()}</dd></div>
          <div><dt>Network</dt><dd>Hedera testnet · EVM chain 296</dd></div>
          <div><dt>Seller account</dt><dd className="mono">{seller.sellerAccount}</dd></div>
          <div><dt>Quote HCS topic</dt><dd className="mono">{seller.quoteTopic}</dd></div>
          <div><dt>Service ID</dt><dd className="mono">{seller.serviceId}</dd></div>
          <div><dt>Escrow contract</dt><dd className="mono">{seller.escrowContractId} · {seller.escrowAddress}</dd></div>
          <div><dt>Buyer cap</dt><dd>{hbar(seller.maxSpendTinybar)}</dd></div>
        </dl>
        <p>These are quote inputs, not an approval to spend. The seller must publish a signed <span className="mono">neuronCustomerQuote/v1</span> to its HCS topic before review is possible. This starter-specific format is not claimed to implement Neuron draft 008 invoices.</p>
      </details>
      <form className="topic-form" onSubmit={inspect}>
        <label htmlFor="quote-sequence">Seller quote&apos;s final HCS sequence</label>
        <input id="quote-sequence" inputMode="numeric" pattern="[1-9][0-9]*" value={sequence}
          onChange={event => setSequence(event.target.value)} autoComplete="off" />
        <button type="submit" disabled={busy}>Verify quote</button>
      </form>
      <p>Maximum configured review amount: {hbar(seller.maxSpendTinybar)}. The signed quote may set a lower amount.</p>
    </>}
    {status === "ready" && intent && <>
      <h2>{intent.state === "reviewed" ? "Quote review recorded" : reviewExpired ? "Seller quote review expired" : "Seller quote inspected"}</h2>
      {reviewExpired && <p className="notice" role="status">This quote or its review window has expired. Close any unresolved funding first, then sign out and sign in again on the stream page. Return here and ask the seller for a new quote using the newly displayed session ID.</p>}
      {intent.state === "reviewed" && sellerQuoteExpired && <p className="notice" role="status">The seller quote has expired. Review remains recorded, but it cannot start new funding.</p>}
      {!reviewExpired && intent.state === "quoted" && <p>The seller signature and current Hedera account key were checked when this quote was inspected. The server checks them again before recording review.</p>}
      <dl className="details">
        <div><dt>Seller payee</dt><dd className="mono">{intent.terms.sellerAddress}</dd></div>
        <div><dt>Buyer wallet</dt><dd className="mono">{intent.terms.buyerAddress}</dd></div>
        <div><dt>Service</dt><dd>{intent.terms.serviceId}</dd></div>
        <div><dt>Customer session</dt><dd className="mono">{intent.terms.sessionId}</dd></div>
        <div><dt>Amount</dt><dd>{hbar(intent.terms.amountTinybar)} ({intent.terms.amountTinybar} tinybar)</dd></div>
        <div><dt>Seller cap</dt><dd>{hbar(intent.terms.maxAmountTinybar)}</dd></div>
        <div><dt>Duration</dt><dd>{intent.terms.durationSeconds} seconds</dd></div>
        <div><dt>Quote expires</dt><dd>{new Date(Number(intent.terms.expiresAt) * 1000).toLocaleString()}</dd></div>
        <div><dt>Refund can start after</dt><dd>{new Date(Number(intent.terms.refundAfter) * 1000).toLocaleString()}</dd></div>
        <div><dt>Escrow contract</dt><dd className="mono">{intent.terms.escrowContractId} · {intent.terms.escrowAddress}</dd></div>
        <div><dt>Signed HCS source</dt><dd className="mono">{intent.quoteTopic} · sequence {intent.quoteSequence}</dd></div>
        <div><dt>Exact terms hash</dt><dd className="mono">{intent.termsHash}</dd></div>
        <div><dt>Review state</dt><dd>{intent.state === "reviewed" ? "Reviewed; funding is a separate step" : reviewExpired ? "Expired, unpaid" : "Awaiting review, unpaid"}</dd></div>
      </dl>
      {intent.state === "quoted" && !reviewExpired && <>
        <p>Read these terms and the wallet message carefully. Your signature records review of this exact hash. A later funding transaction would need a separate, explicit wallet confirmation.</p>
        <button type="button" onClick={review} disabled={busy}>Sign quote review</button>
        <p>Review available until {new Date(intent.reviewBy * 1000).toLocaleString()}.</p>
      </>}
      {intent.state === "reviewed" && <p role="status">Reviewed at {new Date((intent.reviewedAt ?? 0) * 1000).toLocaleString()}. Quote review itself did not move HBAR.</p>}
    </>}
    {status !== "error" && message && <p role="status" aria-live="polite">{message}</p>}
    {network === "testnet" && fundingHistory.length > 0 && <section aria-label="Your escrow history">
      <h2>Your escrow attempts</h2>
      <p>Choose an attempt to check its current chain state or recover a refundable escrow. Older attempts remain available after signing in again with the same buyer wallet.</p>
      <ul>{fundingHistory.map(entry => <li key={entry.id}>
        <button type="button" className="secondary" onClick={() => {
          invalidateReads();
          setRecoveredFundingHash(""); setRecoveredRefundHash(""); setRecoveredApprovalHash("");
          setSelectedFundingId(entry.id); setFunding(null); setFundingTx(null); setRefundTx(null);
          setPendingHash(null); setPendingRefundHash(null); setPendingApprovalHash(null);
          setRefund(null); setApproval(null);
          setRefundRetryConsent({ id: null, accepted: false });
          setApprovalTransportConsent({ id: null, accepted: false });
        }} disabled={walletActionBusy || entry.id === funding?.id}>
          {new Date(entry.preparedAt * 1000).toLocaleString()} · {hbar(entry.amountTinybar)} · {entry.state}
          {entry.escrowId ? ` · escrow ${entry.escrowId}` : ""}
        </button>
      </li>)}</ul>
      <button type="button" className="secondary" disabled={walletActionBusy || historyPage === 0}
        onClick={() => { invalidateReads(); setHistoryPage(page => page - 1); setSelectedFundingId(null); setFunding(null); }}>Newer attempts</button>{" "}
      <button type="button" className="secondary" disabled={walletActionBusy || !historyHasMore}
        onClick={() => { invalidateReads(); setHistoryPage(page => page + 1); setSelectedFundingId(null); setFunding(null); }}>Older attempts</button>
    </section>}
    {(status === "ready" || funding) && (intent?.state === "reviewed" || funding) && <section aria-label="Escrow funding">
      <h2>Buyer-controlled HBAR escrow</h2>
      <p className="notice">Funding is a separate wallet transaction. It locks HBAR in the configured starter escrow; it does not prove delivery or pay the seller. Buyer approval is another explicit transaction and permits the seller to withdraw before the refund deadline.</p>
      {!fundingEnabled && <p role="status">New escrow funding is disabled for this deployment; existing buyer recovery remains available.</p>}
      {fundingEnabled && intent?.state === "reviewed" && funding?.quoteIntentId !== intent.id && !sellerQuoteExpired &&
        <button type="button" disabled={fundingBusy} onClick={prepareFunding}>
        Prepare exact funding transaction
      </button>}
      {fundingEnabled && intent?.state === "reviewed" && funding?.quoteIntentId !== intent.id && sellerQuoteExpired &&
        <p>The quote expired. First close the expired funding attempt below. Then sign out and sign in again on the stream page, return here, and ask the seller for a new signed quote bound to the newly displayed session ID.</p>}
      {funding && <>
        <dl className="details">
          <div><dt>Funding state</dt><dd>{funding.state === "executed" ? "Executed; escrow verified by RPC and Mirror" :
            funding.state === "abandoned" ? "Expired unused quote closed; transaction history preserved" :
            funding.state === "failed" ? "Reported transaction failed; quote outcome still monitored" :
            funding.state === "conflict" ? "Hash or receipt conflict; operator review required" :
              "Outcome pending or uncertain"}</dd></div>
          <div><dt>Amount</dt><dd>{hbar(funding.amountTinybar)}</dd></div>
          {funding.sellerAccountId && <div><dt>Seller account</dt><dd className="mono">{funding.sellerAccountId}</dd></div>}
          <div><dt>Seller recipient</dt><dd className="mono">{funding.sellerAddress}</dd></div>
          <div><dt>Escrow contract</dt><dd className="mono">{funding.contractId} · {funding.contractAddress}</dd></div>
          <div><dt>Terms hash</dt><dd className="mono">{funding.termsHash}</dd></div>
          <div><dt>Refund deadline</dt><dd>{new Date(funding.refundAfter * 1000).toLocaleString()}</dd></div>
          {funding.transactionHash && <div><dt>Transaction</dt><dd className="mono">
            <a href={`https://testnet.mirrornode.hedera.com/api/v1/contracts/results/${funding.transactionHash}`}
              target="_blank" rel="noreferrer">{funding.transactionHash}</a></dd></div>}
          {funding.reportedHash && funding.observedHash && funding.reportedHash !== funding.observedHash &&
            <div><dt>Wallet-reported hash differs</dt><dd className="mono">{funding.reportedHash}</dd></div>}
          {funding.escrowId && <div><dt>Escrow ID</dt><dd>{funding.escrowId}</dd></div>}
          {funding.contractState && <div><dt>Contract reports</dt><dd>{funding.contractState === "paid" ?
            "Seller withdrawal state" : funding.contractState}
            {funding.contractState === "approved" && " — this page has not verified delivery"}</dd></div>}
          {funding.contractState === "paid" && <div><dt>Seller payment</dt><dd>{funding.settlementHash ?
            "Verified: exact Released event, successful withdrawal and native HBAR transfer to seller" :
            "Not yet independently verified; contract storage alone is insufficient"}</dd></div>}
          {funding.settlementHash && <>
            <div><dt>Seller withdrawal transaction</dt><dd className="mono">
              <a href={`https://testnet.mirrornode.hedera.com/api/v1/contracts/results/${funding.settlementHash}`}
                target="_blank" rel="noreferrer">{funding.settlementHash}</a></dd></div>
            <div><dt>Verified transfer</dt><dd>{hbar(funding.settlementAmountTinybar ?? "0")} to <span
              className="mono">{funding.settlementRecipientAddress}</span></dd></div>
            <div><dt>Mirror consensus time</dt><dd className="mono">{funding.settlementMirrorTimestamp}</dd></div>
          </>}
        </dl>
        {fundingTx && funding.state === "prepared" && funding.walletOpenedAt === null && <>
          <p>Wallet transaction prepared for <span className="mono">{fundingTx.to}</span>, value {hbar(funding.amountTinybar)}. The wallet will show its own confirmation before any HBAR moves.</p>
          <p>Maximum displayed gas cost: {hbar(((BigInt(fundingTx.gas) * BigInt(fundingTx.gasPrice) + 9_999_999_999n) / 10_000_000_000n).toString())}.</p>
          <button type="button" disabled={fundingBusy || nowSeconds + 60 >= funding.quoteExpiresAt}
            onClick={() => void sendFunding()}>Send HBAR in wallet</button>
        </>}
        {funding.state === "prepared" && !fundingTx && funding.walletOpenedAt === null &&
          funding.runtimeSha256 && funding.abiPinned && <>
          <p>A funding intent was recorded before any wallet was opened. A fresh quote, contract and gas preflight is required before this buyer can send.</p>
          <button type="button" onClick={() => void sendFunding()} disabled={fundingBusy || !fundingEnabled ||
            nowSeconds + 60 >= funding.quoteExpiresAt}>Recheck and open funding wallet</button>
        </>}
        {funding.state === "prepared" && funding.walletOpenedAt !== null &&
          <p className="notice">The wallet was opened for this funding attempt. Check its history and the chain outcome first. After one minute, an unreported attempt can be retried only with the original unused nonce and enough time left on the quote.</p>}
        {fundingRetryAvailable && <div>
          <label><input type="checkbox" checked={fundingRetryAccepted} disabled={walletActionBusy}
            onChange={event => setFundingRetryConsent({ attemptId: funding.walletAttemptId ?? null,
              accepted: event.target.checked })} /> I checked wallet history and understand this reopens the same funding attempt. A delayed transaction may still appear.</label>
          <p>The server rechecks the quote, contract, chain and nonce before opening the wallet. It will refuse a known pending or consumed nonce; all previous openings stay recorded.</p>
          <button type="button" className="secondary" disabled={walletActionBusy || !fundingRetryAccepted}
            onClick={() => void sendFunding(true)}>Recheck and retry funding wallet</button>
        </div>}
        {funding.state === "prepared" && !fundingTx && !funding.runtimeSha256 &&
          <p className="notice">This older funding intent has no pinned deployment record. It needs operator review before any wallet action.</p>}
        {["prepared", "failed"].includes(funding.state) && nowSeconds > funding.quoteExpiresAt && <button type="button"
          className="secondary" onClick={resolveExpiredFunding} disabled={fundingBusy}>
          Check whether expired quote can be closed
        </button>}
        {funding.state === "abandoned" && funding.abandonedAt && <p role="status">
          Expired attempt closed at {new Date(funding.abandonedAt * 1000).toLocaleString()} after chain and event checks. For another purchase, <Link href="/sessions">sign out and sign in again</Link>, return here, and give the seller the new session ID shown under quote inputs. A quote for the previous session cannot be reused.
        </p>}
        {funding.walletOpenedAt !== null && !funding.reportedHash && !funding.observedHash &&
          funding.state === "prepared" && funding.abandonedAt === null && <div>
          <label htmlFor="recover-funding-hash">Funding hash from wallet history</label>
          <input id="recover-funding-hash" value={recoveredFundingHash} maxLength={66} autoComplete="off"
            onChange={event => setRecoveredFundingHash(event.target.value.trim())} disabled={walletActionBusy} />
          <p>Copy the transaction hash for this funding attempt from the original buyer wallet. Saving it sends no transaction; the server still verifies the exact call and receipt.</p>
          <button type="button" disabled={walletActionBusy || !/^0x[0-9a-fA-F]{64}$/.test(recoveredFundingHash)}
            onClick={() => void recoverWalletHash("funding", funding.id, recoveredFundingHash, funding.walletAttemptId)}>
            Recover funding hash
          </button>
        </div>}
        {pendingHash && !funding.transactionHash && <button type="button" className="secondary"
          onClick={retryHashSave} disabled={fundingBusy}>Save returned transaction hash</button>}
        {(funding.state === "prepared" || funding.state === "submitted" || funding.state === "conflict" ||
          funding.state === "failed" || (funding.state === "executed" && funding.contractState === "paid" &&
          !funding.settlementHash)) && <button type="button" className="secondary"
          onClick={() => { void refreshFunding(); }} disabled={fundingBusy}>Check chain outcome</button>}
        {reconciliation === "unavailable" && <p role="alert">RPC or Mirror reconciliation is unavailable. The displayed record is the last saved evidence; retry no payment transaction.</p>}
        {funding.state === "executed" && funding.contractState && <p>Escrow storage currently reports <strong>{funding.contractState === "paid" ?
          "seller withdrawal state" : funding.contractState}</strong>. {funding.contractState === "paid" ?
          (funding.settlementHash ? "The separate seller transfer evidence above was verified. This does not prove service quality." :
            "The seller transfer has not yet been independently verified; check again after Mirror indexing.") :
          "This state does not prove sensor delivery. The buyer can request a wallet-signed refund after the deadline while the escrow remains funded or approved."}</p>}
        {funding.state === "executed" && funding.contractState === "funded" &&
          approval?.fundingId !== funding.id && approvalEnabled &&
          nowSeconds + 120 < funding.refundAfter && <>
          <p>Approval checks a completed stream connection opened after funding and the confirmed seller request. If a stream was already open, reconnect it and then stop it before checking. Inspect the received data yourself; byte counts alone do not prove quality.</p>
          <button type="button" onClick={prepareApproval} disabled={approvalBusy}>
            Check transport and prepare buyer approval
          </button></>}
        {funding.state === "executed" && funding.contractState === "funded" && !approvalEnabled &&
          <p>Seller withdrawal approval is disabled for this deployment.</p>}
        {funding.state === "executed" && refund?.fundingId !== funding.id &&
          nowSeconds >= funding.refundAfter &&
          (funding.contractState === "funded" || funding.contractState === "approved") &&
          <button type="button" onClick={prepareRefund} disabled={refundBusy}>Prepare buyer refund</button>}
        {funding.state === "executed" && refund?.fundingId !== funding.id &&
          nowSeconds < funding.refundAfter &&
          (funding.contractState === "funded" || funding.contractState === "approved") &&
          <p>Refund is not available until {new Date(funding.refundAfter * 1000).toLocaleString()}.</p>}
      </>}
      {fundingMessage && <p role="status" aria-live="polite">{fundingMessage}</p>}
      {approval && funding && approval.fundingId === funding.id && <section aria-label="Buyer approval">
        <h3>Buyer approval of seller withdrawal</h3>
        <p className="notice">The gateway recorded a completed WebSocket connection with {approval.transportBytes.toLocaleString()} bytes written after the funded escrow and confirmed seller request. This is transport evidence only. It does not prove browser consumption, data quality, or that the seller has withdrawn HBAR.</p>
        <p>The completed connection lasted at least the quoted duration. Bytes and elapsed time still do not independently prove useful service delivery. Decide based on the data you actually received before authorizing withdrawal.</p>
        <p>HCS request <span className="mono">{approval.requestTopic}</span> sequence {approval.requestSequence}; transport opened {new Date(approval.transportOpenedAt).toLocaleString()} and closed {new Date(approval.transportClosedAt).toLocaleString()}.</p>
        <p>Approval state: {approval.state === "executed" ?
          "Executed; Approved event, RPC receipt, Mirror and escrow storage agree" :
          approval.state === "failed" ? "Reported approval transaction failed; outcome still monitored" :
          approval.state === "conflict" ? "Approval hash conflict; operator review required" :
          approval.state === "wallet-opened" ? "Wallet was opened; chain outcome is uncertain" :
          "Prepared or submitted; outcome pending"}.</p>
        {approval.transactionHash && <p className="mono">Approval transaction: <a
          href={`https://testnet.mirrornode.hedera.com/api/v1/contracts/results/${approval.transactionHash}`}
          target="_blank" rel="noreferrer">{approval.transactionHash}</a></p>}
        {approval.reportedHash && approval.observedHash && approval.reportedHash !== approval.observedHash &&
          <p className="mono">Wallet-reported hash differed: {approval.reportedHash}</p>}
        {(["prepared", "failed"].includes(approval.state) ||
          (["wallet-opened", "submitted"].includes(approval.state) && approval.acknowledgedAt !== null && nowSeconds >= approval.acknowledgedAt + 60)) && <>
          <p>Approving escrow {approval.escrowId} permits the named seller to withdraw {funding ? hbar(funding.amountTinybar) : "the escrowed HBAR"} before the refund deadline. Your wallet will ask separately; no HBAR is sent in this approval call.</p>
          <p>The server will recheck the escrow, seller key, request and the same completed transport record before opening your wallet.</p>
          <label><input type="checkbox" checked={approvalTransportAcknowledged}
            onChange={event => setApprovalTransportConsent({ id: approval.id,
              accepted: event.target.checked })} /> I understand gateway bytes and elapsed time are transport evidence, not independent delivery proof, and approval lets the seller withdraw. A retry preserves earlier attempts; an uncertain or legacy transaction may still succeed and additional gas may be charged.</label>
          <button type="button" onClick={sendApproval} disabled={!approvalTransportAcknowledged ||
            approvalBusy || !!pendingApprovalHash || !approvalEnabled || !funding || nowSeconds + 120 >= funding.refundAfter}>
            Recheck and approve seller withdrawal in wallet
          </button>
        </>}
        {approval.acknowledgedAt !== null && !approval.reportedHash && !approval.observedHash &&
          approval.state === "wallet-opened" && <div>
          <label htmlFor="recover-approval-hash">Approval hash from wallet history</label>
          <input id="recover-approval-hash" value={recoveredApprovalHash} maxLength={66} autoComplete="off"
            onChange={event => setRecoveredApprovalHash(event.target.value.trim())} disabled={walletActionBusy} />
          <p>Copy the transaction hash for this approval attempt from the original buyer wallet. Saving it sends no transaction; the server still verifies the exact call and receipt.</p>
          <button type="button" disabled={walletActionBusy || !/^0x[0-9a-fA-F]{64}$/.test(recoveredApprovalHash)}
            onClick={() => void recoverWalletHash("approval", approval.id, recoveredApprovalHash, approval.walletAttemptId)}>
            Recover approval hash
          </button>
        </div>}
        {pendingApprovalHash && !approval.reportedHash && <button type="button" className="secondary"
          onClick={retryApprovalHashSave} disabled={approvalBusy}>Save returned approval hash</button>}
        {approval.state !== "executed" && <button type="button" className="secondary"
          onClick={() => { void refreshApproval(); }} disabled={approvalBusy}>Check approval outcome</button>}
        {approvalReconciliation === "unavailable" && <p role="alert">Approval reconciliation is unavailable. Do not retry until the outcome is known.</p>}
      </section>}
      {approvalMessage && <p role="status" aria-live="polite">{approvalMessage}</p>}
      {refund && funding && refund.fundingId === funding.id && <section aria-label="Buyer refund">
        <h3>Buyer refund</h3>
        <p>Refund state: {refund.state === "executed" ? "Executed; RPC receipt, Mirror and escrow storage agree" :
          refund.state === "failed" ? "Reported refund transaction failed; outcome still monitored" :
          refund.state === "conflict" ? "Refund hash conflict; operator review required" :
            "Pending or uncertain"}.</p>
        <p>Escrow ID {refund.escrowId} · amount {hbar(refund.amountTinybar)}.</p>
        {refund.transactionHash && <p className="mono">Refund transaction: <a
          href={`https://testnet.mirrornode.hedera.com/api/v1/contracts/results/${refund.transactionHash}`}
          target="_blank" rel="noreferrer">{refund.transactionHash}</a></p>}
        {refund.reportedHash && refund.observedHash && refund.reportedHash !== refund.observedHash &&
          <p className="mono">Wallet-reported hash differed: {refund.reportedHash}</p>}
        {refundTx && refund.state === "prepared" && refund.walletOpenedAt === null && <>
          <p>Your wallet will request a buyer-only refund from <span className="mono">{refundTx.to}</span>. This transaction sends 0 HBAR to the contract and needs gas.</p>
          <button type="button" onClick={sendRefund} disabled={refundBusy}>Request refund in wallet</button>
        </>}
        {refund.state === "prepared" && !refundTx && refund.walletOpenedAt === null && <>
          <p>A refund intent was recorded before the wallet was opened. The server will recheck the original escrow and refund deadline before sending.</p>
          <button type="button" onClick={sendRefund} disabled={refundBusy}>Recheck and open refund wallet</button>
        </>}
        {refund.state === "prepared" && refund.walletOpenedAt !== null &&
          <p className="notice">The wallet was opened for this refund. Its outcome may be uncertain; reconcile instead of sending again.</p>}
        {["prepared", "submitted", "failed"].includes(refund.state) && refund.walletOpenedAt !== null &&
          (refund.state === "failed" || nowSeconds >= refund.walletOpenedAt + 60) && !refund.observedHash && <div>
          <p className="notice">Earlier refund wallet attempts remain recorded. After reconciliation and fresh chain checks, retry uses the saved nonce when its outcome is uncertain. Legacy attempts have an unknown nonce and may spend extra gas even if an earlier attempt succeeds. The escrow can refund only once.</p>
          <label><input type="checkbox" checked={refundRetryAccepted}
            onChange={event => setRefundRetryConsent({ id: refund.id,
              accepted: event.target.checked })} /> I understand earlier attempts may still succeed and retry may cost extra gas.</label>
          <button type="button" onClick={retryRefundWallet} disabled={!refundRetryAccepted || refundBusy || !!pendingRefundHash}>
            Reconcile and retry refund in wallet
          </button>
        </div>}
        {refund.walletOpenedAt !== null && !refund.reportedHash && !refund.observedHash &&
          refund.state === "prepared" && <div>
          <label htmlFor="recover-refund-hash">Refund hash from wallet history</label>
          <input id="recover-refund-hash" value={recoveredRefundHash} maxLength={66} autoComplete="off"
            onChange={event => setRecoveredRefundHash(event.target.value.trim())} disabled={walletActionBusy} />
          <p>Copy the transaction hash for this refund attempt from the original buyer wallet. Saving it sends no transaction; the server still verifies the exact call and receipt.</p>
          <button type="button" disabled={walletActionBusy || !/^0x[0-9a-fA-F]{64}$/.test(recoveredRefundHash)}
            onClick={() => void recoverWalletHash("refund", refund.id, recoveredRefundHash, refund.walletAttemptId)}>
            Recover refund hash
          </button>
        </div>}
        {pendingRefundHash && !refund.reportedHash && <button type="button" className="secondary"
          onClick={retryRefundHashSave} disabled={refundBusy}>Save returned refund hash</button>}
        {refund.state !== "executed" && <button type="button" className="secondary"
          onClick={() => { void refreshRefund(); }} disabled={refundBusy}>Check refund outcome</button>}
        {refundReconciliation === "unavailable" && <p role="alert">Refund reconciliation is unavailable. Do not retry until the outcome is known.</p>}
        {refundMessage && <p role="status" aria-live="polite">{refundMessage}</p>}
      </section>}
    </section>}
  </section>;
}
