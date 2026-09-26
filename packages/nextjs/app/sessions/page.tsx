"use client";

import { useEffect, useRef, useState } from "react";
import { ModeSFramer } from "@neuron/hedera";

type Counts = { bytes: number; chunks: number; valid: number; invalid: number; aircraft: number };
type Ticket = { url: string; sellerAccount: string; ticket: string };
type CustomerSession = { sessionId: string; ownerAddress: string; expiresAt: number };
type SellerRequest = { id: string; state: "reserved" | "submitting" | "uncertain" | "confirmed";
  sellerAccount: string; transactionId: string | null; payloadSha256: string | null; topicSequence: number | null };
type WalletProvider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
const emptyCounts = (): Counts => ({ bytes: 0, chunks: 0, valid: 0, invalid: 0, aircraft: 0 });

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
  const [requestEnabled, setRequestEnabled] = useState(false);
  const [sellerRequest, setSellerRequest] = useState<SellerRequest | null>(null);
  const [requestMessage, setRequestMessage] = useState("");
  const [requestBusy, setRequestBusy] = useState(false);
  const [connected, setConnected] = useState(false);

  async function refreshRequest() {
    try {
      const response = await fetch("/api/customer-request", { cache: "no-store" });
      if (response.status === 404) { setRequestEnabled(false); return; }
      if (!response.ok) throw new Error("Seller request status is unavailable");
      const body = await response.json() as { request?: SellerRequest | null };
      setRequestEnabled(true);
      setSellerRequest(body.request ?? null);
    } catch { setRequestMessage("Seller request status is unavailable"); }
  }

  useEffect(() => {
    let active = true;
    fetch("/api/customer-auth/session", { cache: "no-store" }).then(async response => {
      if (!active) return;
      if (response.status === 404) { setAuth("disabled"); return; }
      if (response.status === 401) { setAuth("required"); return; }
      if (!response.ok) { setAuth("unavailable"); return; }
      const session = await response.json() as CustomerSession;
      if (active && typeof session.ownerAddress === "string" && typeof session.sessionId === "string") {
        setAuthSession(session);
        setAuth("signedIn");
        void refreshRequest();
      } else if (active) setAuth("unavailable");
    }).catch(() => { if (active) setAuth("unavailable"); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const sessionGeneration = generation;
    const activeConnection = connection;
    const timer = setInterval(() => {
      setView({ ...counts.current });
      if (connection.current?.readyState === WebSocket.OPEN) {
        const latest = lastByteAt.current || openedAt.current;
        setStatus(Date.now() - latest > 15_000 ? "Stale: no bytes for 15 seconds" :
          lastByteAt.current === 0 ? "Waiting for seller bytes" : "Streaming");
      }
    }, 1_000);
    return () => { clearInterval(timer); sessionGeneration.current++; activeConnection.current?.close(); };
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

  async function signIn() {
    setAuthMessage("Checking Hedera testnet wallet");
    try {
      const provider = (window as Window & { ethereum?: WalletProvider }).ethereum;
      if (!provider) throw new Error("An EVM wallet is required to sign in");
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      if (!Array.isArray(accounts) || typeof accounts[0] !== "string") throw new Error("Wallet did not return an account");
      const chain = await provider.request({ method: "eth_chainId" });
      if (chain !== "0x128") throw new Error("Switch your wallet to Hedera testnet (chain 296)");
      const challengeResponse = await fetch("/api/customer-auth/challenge", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: accounts[0] }) });
      if (!challengeResponse.ok) throw new Error("Could not create a sign-in challenge");
      const challenge: unknown = await challengeResponse.json();
      if (!challenge || typeof challenge !== "object" ||
          typeof (challenge as Record<string, unknown>).message !== "string" ||
          typeof (challenge as Record<string, unknown>).challengeId !== "string" ||
          (challenge as Record<string, unknown>).chainId !== 296) throw new Error("Sign-in challenge was malformed");
      setAuthMessage("Approve the sign-in message in your wallet");
      const signature = await provider.request({ method: "personal_sign",
        params: [(challenge as { message: string }).message, accounts[0]] });
      if (typeof signature !== "string") throw new Error("Wallet did not return a signature");
      const verified = await fetch("/api/customer-auth/verify", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId: (challenge as { challengeId: string }).challengeId, signature }) });
      if (!verified.ok) throw new Error("Wallet sign-in was rejected");
      const session = await verified.json() as CustomerSession;
      if (typeof session.ownerAddress !== "string" || typeof session.sessionId !== "string") {
        throw new Error("Sign-in response was malformed");
      }
      setAuthSession(session);
      setAuth("signedIn");
      setAuthMessage("Signed in. No payment was authorized.");
      void refreshRequest();
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "Wallet sign-in failed");
    }
  }

  async function signOut() {
    stop();
    try {
      const response = await fetch("/api/customer-auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Sign-out request was rejected");
      setAuthSession(null);
      setAuth("required");
      setAuthMessage("Signed out");
      setRequestEnabled(false);
      setSellerRequest(null);
      setRequestMessage("");
    } catch {
      setAuthMessage("Could not sign out. Retry before leaving this browser.");
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
    setRequestBusy(true);
    setRequestMessage("Submitting a testnet HCS service request. Keep this page open.");
    try {
      const response = await fetch("/api/customer-request", { method: "POST", cache: "no-store" });
      const body = await response.json() as { request?: SellerRequest; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Seller request failed");
      if (!body.request) throw new Error("Seller request response was malformed");
      setSellerRequest(body.request);
      setRequestMessage(body.request.state === "confirmed" ?
        "HCS request confirmed. Waiting for seller bytes does not prove delivery." :
        "Request outcome needs operator reconciliation.");
    } catch (error) {
      setRequestMessage(error instanceof Error ? error.message : "Seller request failed");
      await refreshRequest();
    } finally { setRequestBusy(false); }
  }

  return <section>
    <p className="eyebrow">Testnet stream</p>
    <h1>Watch seller data arrive</h1>
    <p>This view reads binary bytes from the configured legacy gateway. The gateway checks the seller&apos;s on-chain key. Valid Mode-S frames are counted only after CRC verification. The legacy stream is not a signed Agent Card or proof of physical sensor origin.</p>
    <p className="notice">This test view can submit a legacy service request on testnet when an operator explicitly enables it. The request does not sign an invoice, pay a seller, or confirm a purchase. Start the testnet gateway before connecting.</p>
    {auth === "required" && <p>Sign in with a Hedera testnet EVM wallet. This authenticates your browser for one hour; the signature does not authorize a payment.</p>}
    {auth === "signedIn" && authSession && <p>Signed in as <span className="mono">{authSession.ownerAddress}</span>.</p>}
    {auth === "unavailable" && <p className="notice">Customer sign-in is unavailable. Live data cannot be connected from this browser.</p>}
    {auth === "required" && <button type="button" className="secondary" onClick={signIn}>Sign in with wallet</button>}
    {auth === "signedIn" && <button type="button" className="secondary" onClick={signOut}>Sign out</button>}
    {authMessage && <p role="status" aria-live="polite">{authMessage}</p>}
    <div className="actions">
      <button type="button" onClick={connect}>Connect</button>
      <button type="button" className="secondary" onClick={stop}>Stop</button>
      {auth === "signedIn" && requestEnabled && <button type="button" className="secondary"
        onClick={requestSellerData} disabled={!connected || requestBusy || Boolean(sellerRequest)}>
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
