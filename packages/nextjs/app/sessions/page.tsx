"use client";

import { useEffect, useRef, useState } from "react";
import { ModeSFramer } from "@neuron/hedera";

type Counts = { bytes: number; chunks: number; valid: number; invalid: number; aircraft: number };
type Ticket = { url: string; sellerAccount: string; ticket: string };
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
    setStatus("Stopped");
  }

  async function connect() {
    stop();
    const current = generation.current;
    setStatus("Checking local testnet gateway");
    try {
      const response = await fetch("/api/local-stream-ticket", { method: "POST", cache: "no-store" });
      const body: unknown = await response.json();
      if (!response.ok || !body || typeof body !== "object") throw new Error("Local testnet gateway is unavailable");
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
        if (current === generation.current) { connection.current = null; setStatus("Disconnected"); }
      };
      socket.onerror = () => { if (current === generation.current) setStatus("Connection error"); };
    } catch (error) {
      if (current === generation.current) setStatus(error instanceof Error ? error.message : "Connection failed");
    }
  }

  return <section>
    <p className="eyebrow">Local testnet stream</p>
    <h1>Watch seller data arrive</h1>
    <p>This view reads binary bytes from the separately started legacy gateway. The gateway checks the seller&apos;s on-chain key. Valid Mode-S frames are counted only after CRC verification. The legacy stream is not a signed Agent Card or proof of physical sensor origin.</p>
    <p className="notice">This test view does not request a service, sign an invoice, pay a seller, or confirm a purchase. Start the testnet gateway and seller request separately before connecting.</p>
    <div className="actions">
      <button type="button" onClick={connect}>Connect</button>
      <button type="button" className="secondary" onClick={stop}>Stop</button>
    </div>
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
