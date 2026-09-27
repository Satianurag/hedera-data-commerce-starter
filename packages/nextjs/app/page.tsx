import Link from "next/link";
import { networkConfigFromEnv } from "@neuron/hedera";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const config = networkConfigFromEnv(process.env);
  return (
    <section>
      <p className="eyebrow">Hedera {config.network} · EVM chain {config.chainId}</p>
      <h1>Explore Neuron services with real network evidence.</h1>
      <p>Browse the live legacy directory, inspect a seller’s Hedera account and topics, and read consensus messages through Mirror Node.</p>
      <p className="notice">This is an independent starter, not an official Neuron release. Directory records and unsigned heartbeats do not prove that a seller’s data stream is connected or that payment is safe.</p>
      <div className="actions">
        <Link className="button" href="/services">Explore services</Link>
        <Link className="button secondary" href="/evidence">Inspect HCS topic</Link>
        <Link className="button secondary" href="/reference">Reference file service</Link>
      </div>
    </section>
  );
}
