"use client";

import { useEffect, useRef, useState } from "react";
import { ModeSFramer } from "@neuron/hedera";
import { InjectedWalletPicker } from "../wallet/picker";
import { selectedInjectedWallet, subscribeWalletInvalidation, type WalletProvider } from "../wallet/injected";

type Counts = { bytes: number; chunks: number; valid: number; invalid: number; aircraft: number };
type Ticket = { url: string; sellerAccount: string; ticket: string };
type CustomerSession = { sessionId: string; ownerAddress: string; expiresAt: number };
type SellerRequest = { id: string; state: "reserved" | "submitting" | "uncertain" | "confirmed";
  sellerAccount: string; transactionId: string | null; payloadSha256: string | null; topicSequence: number | null };
const emptyCounts = (): Counts => ({ bytes: 0, chunks: 0, valid: 0, invalid: 0, aircraft: 0 });
const isTestnetChain = (value: unknown): boolean =>
  typeof value === "string" && /^0x[0-9a-f]+$/i.test(value) && BigInt(value) === 296n;
const walletAddress = (value: unknown): string | null =>
  Array.isArray(value) && typeof value[0] === "string" && /^0x[0-9a-f]{40}$/i.test(value[0]) ? value[0] : null;
const isCustomerSession = (value: unknown): value is CustomerSession =>
  Boolean(value && typeof value === "object" &&
    typeof (value as Record<string, unknown>).sessionId === "string" &&
    typeof (value as Record<string, unknown>).ownerAddress === "string" &&
    /^0x[0-9a-f]{40}$/i.test((value as CustomerSession).ownerAddress) &&
    typeof (value as Record<string, unknown>).expiresAt === "number" &&
    Number.isFinite((value as CustomerSession).expiresAt));

async function matchingWallet(provider: WalletProvider, ownerAddress: string): Promise<void> {
  if (selectedInjectedWallet().provider !== provider) throw new Error("The selected wallet provider changed");
  const [accounts, chain] = await Promise.all([
    provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" }),
  ]);
  if (!isTestnetChain(chain)) throw new Error("Switch your wallet to Hedera testnet (chain 296)");
  if (walletAddress(accounts)?.toLowerCase() !== ownerAddress.toLowerCase()) {
    throw new Error("The connected wallet no longer matches this browser session. Sign out and sign in again.");
  }
  if (selectedInjectedWallet().provider !== provider) throw new Error("The selected wallet provider changed");
}

function walletFailure(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && error.code === 4001) {
    return "Wallet request was rejected. No payment was authorized.";
  }
  return error instanceof Error ? error.message : "Wallet request failed";
}

async function challengeFailure(response: Response): Promise<string> {
  const fallback = "Could not create a sign-in challenge";
  if (response.status !== 403 || !response.body) return fallback;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512) { await reader.cancel(); return fallback; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed && typeof parsed === "object" &&
        (parsed as Record<string, unknown>).error === "Wallet is not enabled for this testnet pilot") {
      return "Wallet is not enabled for this testnet pilot";
    }
  } catch { /* Treat malformed or interrupted error responses as generic failures. */ }
  finally { reader.releaseLock(); }
  return fallback;
}

export default function SessionsPage() {
  const connection = useRef<WebSocket | null>(null);
  const generation = useRef(0);
  const framer = useRef(new ModeSFramer());
  const aircraft = useRef(new Set<string>());
  const counts = useRef<Counts>(emptyCounts());
  const lastByteAt = useRef(0);
  const openedAt = useRef(0);
  const [view, setView] = useState<Counts>(emptyCounts);
  const [status, setStatus] = useState("Stopped");
  const [seller, setSeller] = useState<string | null>(null);
  const [auth, setAuth] = useState<"checking" | "disabled" | "required" | "signedIn" | "unavailable">("checking");
  const [authSession, setAuthSession] = useState<CustomerSession | null>(null);
  const [authMessage, setAuthMessage] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const authBusyRef = useRef(false);
  const authRevision = useRef(0);
  const authSessionRef = useRef<CustomerSession | null>(null);
  const sessionWallet = useRef<WalletProvider | null>(null);
  const [requestEnabled, setRequestEnabled] = useState(false);
  const [sellerRequest, setSellerRequest] = useState<SellerRequest | null>(null);
  const [requestMessage, setRequestMessage] = useState("");
  const [requestBusy, setRequestBusy] = useState(false);
  const [connected, setConnected] = useState(false);

  async function refreshRequest(revision = authRevision.current) {
    try {
      const response = await fetch("/api/customer-request", { cache: "no-store" });
      if (revision !== authRevision.current) return;
      if (response.status === 404) { setRequestEnabled(false); return; }
      if (!response.ok) throw new Error("Seller request status is unavailable");
      const body = await response.json() as { request?: SellerRequest | null };
      if (revision !== authRevision.current) return;
      setRequestEnabled(true);
      setSellerRequest(body.request ?? null);
    } catch { if (revision === authRevision.current) setRequestMessage("Seller request status is unavailable"); }
  }

  useEffect(() => {
    let active = true;
    fetch("/api/customer-auth/session", { cache: "no-store" }).then(async response => {
      if (!active) return;
      if (response.status === 404) { setAuth("disabled"); return; }
      if (response.status === 401) { setAuth("required"); return; }
      if (!response.ok) { setAuth("unavailable"); return; }
      const session: unknown = await response.json();
      if (active && isCustomerSession(session)) {
        authSessionRef.current = session;
        setAuthSession(session);
        setAuth("signedIn");
        void refreshRequest();
        let provider: WalletProvider | null = null;
        try { provider = selectedInjectedWallet().provider; } catch { /* Discovery may still be pending. */ }
        if (provider) {
          const revision = authRevision.current;
          void matchingWallet(provider, session.ownerAddress).then(() => {
            if (active && revision === authRevision.current) sessionWallet.current = provider;
          }).catch(error => {
            if (active && revision === authRevision.current) setAuthMessage(walletFailure(error));
          });
        } else setAuthMessage("Browser session restored. Reconnect the same wallet before using it.");
      } else if (active) setAuth("unavailable");
    }).catch(() => { if (active) setAuth("unavailable"); });
    return () => { active = false; };
  // Session restoration runs once; wallet changes are handled by the listener below.
  }, []);

  useEffect(() => {
    const sessionGeneration = generation;
    const activeConnection = connection;
    const timer = setInterval(() => {
      if (authSessionRef.current && authSessionRef.current.expiresAt <= Date.now() / 1000) {
        authRevision.current++;
        authSessionRef.current = null;
        sessionWallet.current = null;
        setAuthSession(null);
        setAuth("required");
        setAuthMessage("Browser session expired. Sign in again to request seller data.");
        setRequestEnabled(false);
        setSellerRequest(null);
        stop();
        return;
      }
      setView({ ...counts.current });
      if (connection.current?.readyState === WebSocket.OPEN) {
        const latest = lastByteAt.current || openedAt.current;
        setStatus(Date.now() - latest > 15_000 ? "Stale: no bytes for 15 seconds" :
          lastByteAt.current === 0 ? "Waiting for seller bytes" : "Streaming");
      }
    }, 1_000);
    return () => { clearInterval(timer); sessionGeneration.current++; activeConnection.current?.close(); };
  }, []);

  useEffect(() => {
    const walletRevision = authRevision;
    const unsubscribe = subscribeWalletInvalidation(reason => {
      walletRevision.current++;
      const session = authSessionRef.current;
      if (session && (sessionWallet.current || reason === "provider")) {
        void signOut("Wallet account, provider or network changed. Sign in again on Hedera testnet.");
      } else if (session) {
        try {
          const provider = selectedInjectedWallet().provider;
          const revision = walletRevision.current;
          void matchingWallet(provider, session.ownerAddress).then(() => {
            if (revision === walletRevision.current) {
              sessionWallet.current = provider;
              setAuthMessage("");
            }
          }).catch(error => {
            if (revision === walletRevision.current) setAuthMessage(walletFailure(error));
          });
        } catch { setAuthMessage("Choose the wallet used for this browser session before requesting data."); }
      } else if (authBusyRef.current) setAuthMessage("Wallet changed during sign-in. Please try again.");
    });
    return () => {
      unsubscribe();
      walletRevision.current++;
    };
    // The shared provider boundary listens to the chosen EIP-1193 provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stop() {
    generation.current++;
    connection.current?.close();
    connection.current = null;
    framer.current.reset();
    aircraft.current.clear();
    counts.current = emptyCounts();
    setView(emptyCounts());
    lastByteAt.current = 0;
    openedAt.current = 0;
    setSeller(null);
    setConnected(false);
    setStatus("Stopped");
  }

  async function ensureMatchingSession(): Promise<void> {
    const session = authSessionRef.current;
    if (!session) throw new Error("Reconnect the wallet used for this browser session");
    const provider = selectedInjectedWallet().provider;
    if (sessionWallet.current && sessionWallet.current !== provider) {
      throw new Error("Wallet provider changed. Sign out and sign in again.");
    }
    if (session.expiresAt <= Date.now() / 1000) {
      throw new Error("Browser session expired. Sign out and sign in again.");
    }
    await matchingWallet(provider, session.ownerAddress);
  }

  async function discardUnexpectedSession(session: CustomerSession): Promise<void> {
    try {
      const response = await fetch("/api/customer-auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Could not revoke the browser session");
      setAuth("required");
      setAuthMessage("Wallet changed during sign-in. Please sign in again.");
    } catch {
      authSessionRef.current = session;
      setAuthSession(session);
      setAuth("unavailable");
      setAuthMessage("Wallet changed, but the browser session could not be revoked. Retry sign out.");
    }
  }

  async function signIn() {
    if (authBusyRef.current) return;
    authBusyRef.current = true;
    setAuthBusy(true);
    let revision = ++authRevision.current;
    setAuthMessage("Checking Hedera testnet wallet");
    try {
      const provider = selectedInjectedWallet().provider;
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const address = walletAddress(accounts);
      if (!address) throw new Error("Wallet did not return an EVM account");
      const chain = await provider.request({ method: "eth_chainId" });
      if (!isTestnetChain(chain)) throw new Error("Switch your wallet to Hedera testnet (chain 296)");
      // Granting account access can itself emit accountsChanged. Adopt that settled state.
      await matchingWallet(provider, address);
      revision = authRevision.current;
      const challengeResponse = await fetch("/api/customer-auth/challenge", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) });
      if (!challengeResponse.ok) throw new Error(await challengeFailure(challengeResponse));
      const challenge: unknown = await challengeResponse.json();
      if (!challenge || typeof challenge !== "object" ||
          typeof (challenge as Record<string, unknown>).message !== "string" ||
          typeof (challenge as Record<string, unknown>).challengeId !== "string" ||
          (challenge as Record<string, unknown>).chainId !== 296) throw new Error("Sign-in challenge was malformed");
      if (revision !== authRevision.current) return;
      setAuthMessage("Approve the sign-in message in your wallet");
      const signature = await provider.request({ method: "personal_sign",
        params: [(challenge as { message: string }).message, address] });
      if (typeof signature !== "string") throw new Error("Wallet did not return a signature");
      await matchingWallet(provider, address);
      if (revision !== authRevision.current) return;
      const verified = await fetch("/api/customer-auth/verify", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId: (challenge as { challengeId: string }).challengeId, signature }) });
      if (!verified.ok) throw new Error("Wallet sign-in was rejected");
      const session: unknown = await verified.json().catch(() => null);
      if (!isCustomerSession(session)) {
        try {
          const response = await fetch("/api/customer-auth/logout", { method: "POST" });
          if (!response.ok) throw new Error("Could not revoke the browser session");
        } catch {
          setAuth("unavailable");
          setAuthMessage("Sign-in response was invalid and the browser session could not be revoked. Retry sign out.");
          return;
        }
        throw new Error("Sign-in response was malformed");
      }
      if (revision !== authRevision.current) {
        await discardUnexpectedSession(session);
        return;
      }
      try { await matchingWallet(provider, session.ownerAddress); } catch {
        await discardUnexpectedSession(session);
        return;
      }
      if (revision !== authRevision.current) {
        await discardUnexpectedSession(session);
        return;
      }
      authSessionRef.current = session;
      sessionWallet.current = provider;
      setAuthSession(session);
      setAuth("signedIn");
      setAuthMessage("Signed in. No payment was authorized.");
      void refreshRequest();
    } catch (error) {
      if (revision === authRevision.current) setAuthMessage(walletFailure(error));
    } finally {
      authBusyRef.current = false;
      setAuthBusy(false);
      if (revision !== authRevision.current && authSessionRef.current) {
        void signOut("Wallet account or network changed. Sign in again on Hedera testnet.");
      }
    }
  }

  async function signOut(reason = "Signed out") {
    if (authBusyRef.current) return;
    authBusyRef.current = true;
    setAuthBusy(true);
    authRevision.current++;
    stop();
    setAuth("checking");
    setRequestEnabled(false);
    setSellerRequest(null);
    setRequestMessage("");
    try {
      const response = await fetch("/api/customer-auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Sign-out request was rejected");
      authSessionRef.current = null;
      sessionWallet.current = null;
      setAuthSession(null);
      setAuth("required");
      setAuthMessage(reason);
    } catch {
      setAuth("unavailable");
      setAuthMessage("Could not revoke the browser session. Retry sign out before using this app again.");
    } finally {
      authBusyRef.current = false;
      setAuthBusy(false);
    }
  }

  async function connect() {
    stop();
    if (auth === "required" || auth === "checking" || auth === "unavailable") {
      setStatus("Customer sign-in is required or unavailable");
      return;
    }
    const current = generation.current;
    setStatus("Checking testnet gateway");
    try {
      if (auth === "signedIn") await ensureMatchingSession();
      if (current !== generation.current) return;
      const response = await fetch("/api/local-stream-ticket", { method: "POST", cache: "no-store" });
      const body: unknown = await response.json();
      if (!response.ok || !body || typeof body !== "object") throw new Error("Testnet gateway is unavailable");
      const ticket = body as Partial<Ticket>;
      if (typeof ticket.url !== "string" || typeof ticket.ticket !== "string" || typeof ticket.sellerAccount !== "string") {
        throw new Error("Gateway ticket was malformed");
      }
      if (current !== generation.current) return;
      const socket = new WebSocket(ticket.url, ["neuron.v1", ticket.ticket]);
      socket.binaryType = "arraybuffer";
      connection.current = socket;
      setSeller(ticket.sellerAccount);
      setStatus("Connecting to seller stream");
      socket.onopen = () => {
        if (current === generation.current) {
          openedAt.current = Date.now();
          setConnected(true);
          setStatus("Waiting for seller bytes");
        }
      };
      socket.onmessage = event => {
        if (current !== generation.current) return;
        if (!(event.data instanceof ArrayBuffer)) { socket.close(1003, "binary frames required"); return; }
        const bytes = new Uint8Array(event.data);
        try {
          const frames = framer.current.push(bytes);
          counts.current.bytes += bytes.length;
          counts.current.chunks++;
          lastByteAt.current = Date.now();
          for (const frame of frames) {
            if (frame.downlinkFormat !== 17) continue;
            if (frame.crcValid) {
              counts.current.valid++;
              if (frame.icao24 && aircraft.current.size < 4096) aircraft.current.add(frame.icao24);
            } else counts.current.invalid++;
          }
          counts.current.aircraft = aircraft.current.size;
        } catch { socket.close(1009, "binary chunk limit exceeded"); }
      };
      socket.onclose = () => {
        if (current === generation.current) { connection.current = null; setConnected(false); setStatus("Disconnected"); }
      };
      socket.onerror = () => { if (current === generation.current) setStatus("Connection error"); };
    } catch (error) {
      if (current === generation.current) setStatus(error instanceof Error ? error.message : "Connection failed");
    }
  }

  async function requestSellerData() {
    if (!connected || !requestEnabled || requestBusy) return;
    const revision = authRevision.current;
    const connectionGeneration = generation.current;
    setRequestBusy(true);
    setRequestMessage("Submitting a testnet HCS service request. Keep this page open.");
    try {
      await ensureMatchingSession();
      if (revision !== authRevision.current || connectionGeneration !== generation.current) return;
      const response = await fetch("/api/customer-request", { method: "POST", cache: "no-store" });
      const body = await response.json() as { request?: SellerRequest; error?: string };
      if (revision !== authRevision.current) return;
      if (!response.ok) throw new Error(body.error ?? "Seller request failed");
      if (!body.request) throw new Error("Seller request response was malformed");
      setSellerRequest(body.request);
      setRequestMessage(body.request.state === "confirmed" ?
        "HCS request confirmed. Waiting for seller bytes does not prove delivery." :
        "Request outcome needs operator reconciliation.");
    } catch (error) {
      if (revision === authRevision.current) {
        setRequestMessage(error instanceof Error ? error.message : "Seller request failed");
        await refreshRequest(revision);
      }
    } finally { setRequestBusy(false); }
  }

  return <section>
    <p className="eyebrow">Testnet stream</p>
    <h1>Watch seller data arrive</h1>
    <p>This view reads binary bytes from the configured legacy gateway. The gateway checks the seller&apos;s on-chain key. Valid Mode-S frames are counted only after CRC verification. The legacy stream is not a signed Agent Card or proof of physical sensor origin.</p>
    <p className="notice">This test view can submit a legacy service request on testnet when an operator explicitly enables it. The request does not sign an invoice, pay a seller, or confirm a purchase. Start the testnet gateway before connecting.</p>
    {auth === "checking" && <p role="status">Checking your browser session…</p>}
    {auth === "disabled" && <p>Wallet sign-in is disabled for this read-only or local configuration.</p>}
    {auth === "required" && <p>Sign in with a Hedera testnet EVM wallet. This authenticates your browser for one hour; the signature does not authorize a payment.</p>}
    {(auth === "required" || auth === "signedIn") && <InjectedWalletPicker />}
    {auth === "signedIn" && authSession && <p>Signed in as <span className="mono">{authSession.ownerAddress}</span>.</p>}
    {auth === "unavailable" && <p className="notice">Customer sign-in is unavailable. Live data cannot be connected from this browser.</p>}
    {auth === "required" && <button type="button" className="secondary" onClick={signIn} disabled={authBusy}>
      {authBusy ? "Waiting for wallet" : "Sign in with wallet"}</button>}
    {(authSession || auth === "unavailable") && <button type="button" className="secondary"
      onClick={() => void signOut()} disabled={authBusy}>Sign out</button>}
    {authMessage && <p role="status" aria-live="polite">{authMessage}</p>}
    <div className="actions">
      <button type="button" onClick={connect} disabled={authBusy}>Connect</button>
      <button type="button" className="secondary" onClick={stop}>Stop</button>
      {auth === "signedIn" && requestEnabled && <button type="button" className="secondary"
        onClick={requestSellerData} disabled={!connected || requestBusy || authBusy || Boolean(sellerRequest)}>
        {requestBusy ? "Submitting request" : "Request seller data"}
      </button>}
    </div>
    {requestMessage && <p role="status" aria-live="polite">{requestMessage}</p>}
    {sellerRequest && <p>Testnet HCS request: {sellerRequest.state}
      {sellerRequest.transactionId && <> · <span className="mono">{sellerRequest.transactionId}</span></>}
      {sellerRequest.topicSequence && <> · topic sequence {sellerRequest.topicSequence}</>}
    </p>}
    <p role="status" aria-live="polite">Status: {status}</p>
    {seller && <p>Legacy seller account: <span className="mono">{seller}</span></p>}
    <dl className="details">
      <div><dt>Raw bytes</dt><dd>{view.bytes.toLocaleString()}</dd></div>
      <div><dt>Binary messages</dt><dd>{view.chunks.toLocaleString()}</dd></div>
      <div><dt>CRC-valid DF17 frames</dt><dd>{view.valid.toLocaleString()}</dd></div>
      <div><dt>CRC-invalid DF17 frames</dt><dd>{view.invalid.toLocaleString()}</dd></div>
      <div><dt>Distinct ICAO24 addresses (up to 4,096)</dt><dd>{view.aircraft.toLocaleString()}</dd></div>
    </dl>
  </section>;
}
