"use client";

import Link from "next/link";
import { formatUnits } from "ethers";
import { useCallback, useEffect, useRef, useState } from "react";
import { InjectedWalletPicker } from "../wallet/picker";
import { assertInjectedWallet, selectedInjectedWallet, subscribeWalletInvalidation } from "../wallet/injected";
import { prepareReferenceGas } from "../../lib/reference-gas";
import { parseReferenceConfig, parseReferenceSession, referenceWalletFailure, validateReferenceTransaction,
  type ReferenceConfig, type ReferenceKind, type ReferenceSession } from "../../lib/reference-types";

type BrowserSession = { ownerAddress: string; sessionId: string; expiresAt: number };
type Status = "loading" | "disabled" | "sign-in" | "ready" | "error";
const labels: Record<ReferenceKind, string> = { create: "Create this escrow", "token-approve": "Approve this exact token amount",
  deposit: "Deposit payment into escrow", "approve-release": "Approve payment to seller", refund: "Refund remaining escrow funds" };
function savedHashKey(id: string, intent: string): string { return `neuron-reference-tx:${id}:${intent}`; }
function savedHash(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function saveHash(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* Attach the hash to the server even when browser storage is unavailable. */ }
}
async function requestJSON(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", cache: "no-store",
    signal: AbortSignal.timeout(245_000), ...(body === undefined ? {} : {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Reference service is unavailable");
  return data;
}

export default function ReferenceClient({ network }: { network: "testnet" | "mainnet" }) {
  const [status, setStatus] = useState<Status>(network === "testnet" ? "loading" : "disabled");
  const [customer, setCustomer] = useState<BrowserSession | null>(null);
  const [config, setConfig] = useState<ReferenceConfig | null>(null);
  const [sessions, setSessions] = useState<ReferenceSession[]>([]);
  const [session, setSession] = useState<ReferenceSession | null>(null);
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [consent, setConsent] = useState("");
  const [submittedHash, setSubmittedHash] = useState("");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const selectedId = useRef<string | null>(null);

  const apply = useCallback((data: Record<string, unknown>, owner: string): ReferenceSession => {
    const currentConfig = parseReferenceConfig(data.config);
    const current = parseReferenceSession(data.session, currentConfig, owner);
    setConfig(currentConfig);
    setSession(current);
    selectedId.current = current.id;
    setSessions(rows => [current, ...rows.filter(row => row.id !== current.id)]);
    setConsent("");
    const hash = current.pendingIntent ? savedHash(savedHashKey(current.id, current.pendingIntent.id)) : null;
    setSubmittedHash(hash && /^0x[a-fA-F0-9]{64}$/.test(hash) ? hash : "");
    return current;
  }, []);

  const refresh = useCallback(async () => {
    if (network !== "testnet") return;
    try {
      const signedIn = await fetch("/api/customer-auth/session", { cache: "no-store" });
      if (signedIn.status === 401) { setStatus("sign-in"); setCustomer(null); return; }
      if (signedIn.status === 404) { setStatus("disabled"); return; }
      if (!signedIn.ok) throw new Error("Browser sign-in is unavailable");
      const auth = await signedIn.json() as BrowserSession;
      if (!auth || !/^0x[a-fA-F0-9]{40}$/.test(auth.ownerAddress) || !/^[a-f0-9]{32}$/.test(auth.sessionId) || !Number.isSafeInteger(auth.expiresAt)) throw new Error("Browser session was malformed");
      setCustomer(auth);
      const response = await fetch("/api/reference", { cache: "no-store", signal: AbortSignal.timeout(245_000) });
      if (response.status === 404) { setStatus("disabled"); return; }
      if (!response.ok) throw new Error("Reference service is unavailable. Its operator must configure the testnet bridge.");
      const body = await response.json() as Record<string, unknown>;
      const currentConfig = parseReferenceConfig(body.config);
      if (!Array.isArray(body.sessions) || !Array.isArray(body.pendingSessionIds)) throw new Error("Reference session list was malformed");
      const rows = body.sessions.map(row => parseReferenceSession(row, currentConfig, auth.ownerAddress));
      setConfig(currentConfig); setSessions(rows); setPendingIds(body.pendingSessionIds as string[]);
      const chosen = rows.find(row => row.id === selectedId.current) ?? rows[0] ?? null;
      if (chosen) apply({ config: currentConfig, session: chosen }, auth.ownerAddress);
      else { setSession(null); selectedId.current = null; }
      setStatus("ready");
    } catch (error) { setStatus("error"); setMessage(referenceWalletFailure(error)); }
  }, [network, apply]);
  useEffect(() => {
    const initial = setTimeout(() => { void refresh(); }, 0);
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    const unsubscribe = subscribeWalletInvalidation(() => {
      setConsent(""); setMessage("Wallet selection, account or network changed. Recheck the signed-in buyer before signing.");
    });
    return () => { clearTimeout(initial); clearInterval(timer); unsubscribe(); };
  }, [refresh]);

  async function work(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setMessage("");
    try { await action(); } catch (error) { setMessage(referenceWalletFailure(error)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function start() {
    if (!customer) return;
    await work(async () => {
      setMessage("Exchanging signed service messages on Hedera testnet…");
      const current = apply(await requestJSON("/api/reference", { action: "start" }), customer.ownerAddress);
      setMessage(current.message || "Review the agreed file, token amount, seller and refund deadline before opening your wallet.");
    });
  }
  async function action(name: "refresh" | "deliver" | "settle") {
    if (!session || !customer) return;
    await work(async () => {
      setMessage(name === "deliver" ? "Receiving the seller's file and verifying delivery evidence…" : "Reconciling Hedera testnet state…");
      const current = apply(await requestJSON(`/api/reference/sessions/${session.id}`, { action: name }), customer.ownerAddress);
      setMessage(current.message);
    });
  }
  async function walletAction(kind: ReferenceKind) {
    if (!session || !config || !customer || consent !== `${session.id}:${kind}`) return;
    await work(async () => {
      const wallet = selectedInjectedWallet();
      const assertBuyer = async () => {
        assertInjectedWallet(wallet.provider, wallet.revision);
        const [chain, accounts] = await Promise.all([
          wallet.provider.request({ method: "eth_chainId" }), wallet.provider.request({ method: "eth_accounts" }),
        ]);
        if (chain !== "0x128" && chain !== 296 && chain !== "296") throw new Error("Select Hedera testnet (chain 296) in your wallet");
        if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || accounts[0].toLowerCase() !== customer.ownerAddress.toLowerCase()) throw new Error("Select the same wallet account used to sign in");
        assertInjectedWallet(wallet.provider, wallet.revision);
      };
      await assertBuyer();
      const prepared = session.pendingIntent?.kind === kind && ["prepared", "wallet-open"].includes(session.pendingIntent.status) && !session.pendingIntent.transactionHash ?
        apply(await requestJSON(`/api/reference/sessions/${session.id}`), customer.ownerAddress) :
        apply(await requestJSON(`/api/reference/sessions/${session.id}`, { action: "prepare", kind }), customer.ownerAddress);
      const intent = prepared.pendingIntent;
      if (!intent || intent.kind !== kind || intent.transactionHash || !["prepared", "wallet-open"].includes(intent.status)) throw new Error("Wallet intent is not ready; refresh its status");
      if (!intent.transaction.nonce) throw new Error("This older wallet operation has no recorded nonce. Check wallet activity and reconcile its hash; it cannot be retried safely from this page.");
      const retryingUncertain = intent.status === "wallet-open";
      validateReferenceTransaction(intent.transaction, prepared, config);
      const key = savedHashKey(prepared.id, intent.id);
      if (savedHash(key)) throw new Error("A transaction hash already exists for this intent. Reconcile it before opening the wallet again.");
      setMessage("Checking the buffered gas limit, maximum network fee and available HBAR…");
      const gas = await prepareReferenceGas(wallet.provider, customer.ownerAddress, intent.transaction);
      try { await assertBuyer(); } catch (error) {
        if (!retryingUncertain) apply(await requestJSON(`/api/reference/sessions/${prepared.id}`, { action: "cancel", intentId: intent.id }), customer.ownerAddress);
        throw error;
      }
      const opened = apply(await requestJSON(`/api/reference/sessions/${prepared.id}`, { action: "open-wallet", intentId: intent.id }), customer.ownerAddress);
      if (opened.pendingIntent?.id !== intent.id || opened.pendingIntent.status !== "wallet-open" || opened.pendingIntent.transactionHash) {
        throw new Error("Wallet operation was not opened. Refresh before retrying.");
      }
      const openedTransaction = opened.pendingIntent.transaction;
      if (openedTransaction.nonce !== intent.transaction.nonce || openedTransaction.data !== intent.transaction.data ||
          openedTransaction.to !== intent.transaction.to || openedTransaction.value !== intent.transaction.value ||
          opened.buyerAddress !== prepared.buyerAddress) throw new Error("The persisted wallet operation changed; no transaction was requested.");
      try { await assertBuyer(); } catch (error) {
        // The provider has not been called, so no transaction can have been broadcast by this attempt.
        if (!retryingUncertain) apply(await requestJSON(`/api/reference/sessions/${prepared.id}`, { action: "wallet-rejected", intentId: intent.id }), customer.ownerAddress);
        throw error;
      }
      let result: unknown;
      try {
        setMessage(`Review this single testnet transaction in your wallet. Maximum network fee: ${formatUnits(gas.maximumFeeWei, 18)} HBAR.`);
        result = await wallet.provider.request({ method: "eth_sendTransaction", params: [{ from: customer.ownerAddress,
          to: intent.transaction.to, data: intent.transaction.data, value: "0x0", chainId: "0x128", nonce: intent.transaction.nonce,
          gas: gas.gas, gasPrice: gas.gasPrice }] });
      } catch (error) {
        if (!retryingUncertain && error && typeof error === "object" && "code" in error && error.code === 4001) {
          apply(await requestJSON(`/api/reference/sessions/${prepared.id}`, { action: "wallet-rejected", intentId: intent.id }), customer.ownerAddress);
        }
        throw error;
      }
      if (typeof result !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(result)) throw new Error("Wallet did not return a usable transaction hash. Check its activity and reconcile before retrying.");
      setSubmittedHash(result);
      saveHash(key, result);
      setMessage("Transaction submitted. Checking the exact executed call and receipt…");
      const reconciled = apply(await requestJSON(`/api/reference/sessions/${prepared.id}`, {
        action: "submitted", intentId: intent.id, transactionHash: result,
      }), customer.ownerAddress);
      setMessage(reconciled.message);
    });
  }
  async function attachHash() {
    if (!session?.pendingIntent || !customer || !/^0x[a-fA-F0-9]{64}$/.test(submittedHash)) return;
    await work(async () => {
      saveHash(savedHashKey(session.id, session.pendingIntent!.id), submittedHash);
      const current = apply(await requestJSON(`/api/reference/sessions/${session.id}`, {
        action: "submitted", intentId: session.pendingIntent!.id, transactionHash: submittedHash,
      }), customer.ownerAddress);
      setMessage(current.message);
    });
  }
  async function cancelUnopened() {
    if (!session?.pendingIntent || session.pendingIntent.status !== "prepared" || session.pendingIntent.transactionHash || !customer) return;
    await work(async () => {
      const current = apply(await requestJSON(`/api/reference/sessions/${session.id}`, {
        action: "cancel", intentId: session.pendingIntent!.id,
      }), customer.ownerAddress);
      setMessage(current.message);
    });
  }
  const expired = Boolean(session && now >= session.deadline);
  return <section>
    <p className="eyebrow">Hedera testnet · reference file service</p>
    <h1>Receive a file from a Neuron seller</h1>
    <p>Request the configured seller&apos;s file, review its signed agreement, fund an escrow and inspect the delivered file before approving payment. Each payment action needs your wallet confirmation.</p>
    <p className="notice">This service uses Neuron&apos;s pinned reference protocol and an ERC20 test token. The seller is operated for this template. Its file delivery is separate from the <Link href="/sessions">legacy live aircraft stream</Link> and the <Link href="/commerce">native HBAR extension</Link>.</p>
    {status === "loading" && <p role="status">Checking your session and reference seller…</p>}
    {status === "sign-in" && <p><Link href="/sessions">Sign in with a Hedera testnet wallet</Link>, then return to this page.</p>}
    {status === "disabled" && <p>Reference commerce is not enabled for this deployment. Mainnet is unavailable until its separate release requirements are met.</p>}
    <div className="actions"><button className="secondary" disabled={busy} onClick={() => void work(refresh)}>Refresh service</button></div>
    {message && <p role="status" aria-live="polite">{message}</p>}
    {status === "ready" && config && customer && <>
      <InjectedWalletPicker />
      <h2>{config.service.name}</h2>
      <dl className="details">
        <div><dt>File</dt><dd>{config.service.filename} · {config.service.bytes.toLocaleString()} bytes</dd></div>
        <div><dt>Exact price</dt><dd>{formatUnits(config.service.priceBaseUnits, config.service.tokenDecimals)} {config.service.tokenSymbol} · {config.service.priceBaseUnits} base units</dd></div>
        <div><dt>Token contract</dt><dd className="mono">{config.service.tokenAddress}</dd></div>
        <div><dt>Seller / recipient</dt><dd className="mono">{config.service.sellerAddress}</dd></div>
        <div><dt>Your buyer wallet</dt><dd className="mono">{customer.ownerAddress}</dd></div>
        <div><dt>Escrow contract</dt><dd className="mono">{config.escrowAddress}</dd></div>
        <div><dt>File SHA-256</dt><dd className="mono">{config.service.sha256}</dd></div>
      </dl>
      <p>{config.identityNote}</p>
      <p>Network fees are additional testnet HBAR. The token approval is limited to the displayed exact price.</p>
      <button disabled={busy || now >= customer.expiresAt} onClick={() => void start()}>Request signed service agreement</button>
      {pendingIds.length > 0 && <p className="notice">{pendingIds.length} saved session(s) could not be reconciled. Refresh before creating a replacement; an earlier request may still be processing.</p>}
      {sessions.length > 0 && <div className="wallet-picker"><label htmlFor="reference-session">Your recent sessions</label>
        <select id="reference-session" disabled={busy} value={session?.id ?? ""} onChange={event => {
          const chosen = sessions.find(row => row.id === event.target.value);
          if (chosen) apply({ config, session: chosen }, customer.ownerAddress);
        }}>{sessions.map(row => <option key={row.id} value={row.id}>{row.id} · {row.state}</option>)}</select></div>}
      {session && <>
        <h2>Session: {session.state}</h2>
        <p>{session.message}</p>
        <dl className="details">
          <div><dt>Session ID</dt><dd className="mono">{session.id}</dd></div>
          <div><dt>Agreement hash</dt><dd className="mono">{session.agreementHash || "Agreement not yet confirmed"}</dd></div>
          {session.escrowId && <div><dt>Escrow ID</dt><dd>{session.escrowId}</dd></div>}
          <div><dt>Refund eligible from</dt><dd>{new Date(session.deadline * 1000).toLocaleString()} {expired ? "(deadline reached)" : ""}</dd></div>
        </dl>
        <div className="actions">
          <button className="secondary" disabled={busy} onClick={() => void action("refresh")}>Reconcile this session</button>
          {session.state === "funded" && !expired && <button disabled={busy} onClick={() => void action("deliver")}>Receive seller&apos;s file</button>}
          {session.state === "approved" && <button disabled={busy} onClick={() => void action("settle")}>Complete seller withdrawal</button>}
        </div>
        {session.delivery && <div className="notice"><h3>Delivered file</h3>
          <p>{session.delivery.filename} · {session.delivery.bytes.toLocaleString()} bytes. The received SHA-256 matches the agreed file.</p>
          <a className="button secondary" href={session.delivery.downloadPath}>Download and inspect file</a>
          <p>A matching file hash verifies the bytes. You decide whether the file meets your requirements before approving payment.</p></div>}
        {!session.pendingIntent && session.walletActions.map(item => <div key={item.kind} className="notice">
          <h3>{labels[item.kind]}</h3>
          <p>{item.kind === "approve-release" ? `Approval permits ${config.service.sellerAddress} to receive ${config.service.priceBaseUnits} base units of ${config.service.tokenSymbol}. Check the file and signed invoice first.` : item.label}</p>
          <label><input type="checkbox" checked={consent === `${session.id}:${item.kind}`} disabled={busy}
            onChange={event => setConsent(event.target.checked ? `${session.id}:${item.kind}` : "")} /> {item.kind === "approve-release" ? "I inspected the delivered file and authorize payment to the displayed seller." : "I reviewed the network, recipient, token, exact amount and refund deadline."}</label>
          <div className="actions"><button disabled={busy || consent !== `${session.id}:${item.kind}` || now >= customer.expiresAt || (expired && item.kind !== "refund")}
            onClick={() => void walletAction(item.kind)}>{labels[item.kind]} in wallet</button></div>
        </div>)}
        {session.pendingIntent?.status === "prepared" && !session.pendingIntent.transactionHash ? <div className="notice">
          <h3>Prepared wallet operation</h3>
          <p>{labels[session.pendingIntent.kind]} was prepared, and this app has not opened its wallet prompt. You can resume it or cancel this unopened operation.</p>
          <label><input type="checkbox" disabled={busy} checked={consent === `${session.id}:${session.pendingIntent.kind}`}
            onChange={event => setConsent(event.target.checked ? `${session.id}:${session.pendingIntent!.kind}` : "")} />
            {session.pendingIntent.kind === "approve-release" ? " I inspected the delivered file and authorize payment to the displayed seller." : " I reviewed this exact testnet transaction and its refund deadline."}</label>
          <div className="actions"><button disabled={busy || consent !== `${session.id}:${session.pendingIntent.kind}` || now >= customer.expiresAt || (expired && session.pendingIntent.kind !== "refund")}
            onClick={() => void walletAction(session.pendingIntent!.kind)}>Resume in wallet</button>
          <button className="secondary" disabled={busy} onClick={() => void cancelUnopened()}>Cancel unopened operation</button></div>
        </div> : session.pendingIntent && <div className="notice"><h3>Pending wallet operation</h3>
          <p>{labels[session.pendingIntent.kind]} · {session.pendingIntent.status}. If the wallet already submitted it, reconcile its transaction hash below. A missing browser response does not mean the transaction failed.</p>
          {session.pendingIntent.status === "wallet-open" && !session.pendingIntent.transactionHash && session.pendingIntent.transaction.nonce && <>
            <p>This operation reserved wallet nonce <span className="mono">{session.pendingIntent.transaction.nonce}</span>. An explicit retry uses the identical recipient, data, value and nonce, so the original and retry cannot both execute. The bridge refuses retry if that nonce was already consumed.</p>
            <label><input type="checkbox" disabled={busy} checked={consent === `${session.id}:${session.pendingIntent.kind}`}
              onChange={event => setConsent(event.target.checked ? `${session.id}:${session.pendingIntent!.kind}` : "")} /> I want to retry this identical transaction after checking my wallet activity.</label>
            <div className="actions"><button disabled={busy || consent !== `${session.id}:${session.pendingIntent.kind}` || now >= customer.expiresAt || (expired && session.pendingIntent.kind !== "refund")}
              onClick={() => void walletAction(session.pendingIntent!.kind)}>Retry identical transaction in wallet</button></div>
          </>}
          <div className="topic-form"><label htmlFor="reference-transaction">Transaction hash</label><input id="reference-transaction" value={submittedHash}
            onChange={event => setSubmittedHash(event.target.value)} maxLength={66} placeholder="0x…" disabled={busy} />
          <button disabled={busy || !/^0x[a-fA-F0-9]{64}$/.test(submittedHash)} onClick={() => void attachHash()}>Reconcile transaction</button></div>
        </div>}
        {session.messages.length > 0 && <><h3>Signed protocol messages</h3><ul>{session.messages.map(item => <li key={`${item.topicId}:${item.sequenceNumber}`}>
          {item.sequenceNumber === "0" ? <span>{item.kind} · HCS submission pending</span> : <a href={`https://testnet.mirrornode.hedera.com/api/v1/topics/${item.topicId}/messages/${item.sequenceNumber}`} target="_blank" rel="noreferrer">{item.kind} · {item.topicId}/{item.sequenceNumber}</a>}
          {item.mirrorVerified ? " · exact bytes reconciled with Mirror" : " · Mirror reconciliation pending"}
          <details><summary>Message fields</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(item.payload, null, 2)}</pre></details>
        </li>)}</ul></>}
        {session.transactions.length > 0 && <><h3>Recorded transactions</h3><ul>{session.transactions.map(item => <li key={`${item.kind}:${item.transactionHash}`}>
          {item.kind} · {item.status} · <a className="mono" href={`https://hashscan.io/testnet/transaction/${item.transactionHash}`} target="_blank" rel="noreferrer">{item.transactionHash}</a>
        </li>)}</ul></>}
      </>}
      <p>Reference revision: <a href={`https://github.com/NeuronInnovations/neuron-specs/tree/${config.sourceRevision}`} target="_blank" rel="noreferrer">{config.sourceRevision.slice(0, 7)}</a>. This page claims compatibility only with the configured implementation and settlement binding.</p>
    </>}
  </section>;
}
