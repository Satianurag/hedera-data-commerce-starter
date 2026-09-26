import { createHash } from "node:crypto";
import { getLatestTopicMessage, networkConfigFromEnv } from "@neuron/hedera";

export const dynamic = "force-dynamic";

export default async function EvidencePage({ searchParams }: { searchParams: Promise<{ topic?: string }> }) {
  const { topic } = await searchParams;
  const config = networkConfigFromEnv(process.env);
  let message: Awaited<ReturnType<typeof getLatestTopicMessage>> = null;
  let error: string | undefined;
  if (topic) {
    try {
      message = await getLatestTopicMessage(config, topic);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Evidence lookup failed";
    }
  }

  return (
    <section>
      <p className="eyebrow">Hedera {config.network} · Mirror Node</p>
      <h1>HCS evidence</h1>
      <form action="/evidence" className="topic-form">
        <label htmlFor="topic">Topic ID</label>
        <input id="topic" name="topic" defaultValue={topic ?? ""} placeholder="0.0.12345" required />
        <button type="submit">Inspect</button>
      </form>
      {error && <p role="alert" className="notice">{error}</p>}
      {topic && !error && !message && <p>The topic exists, but it has no messages.</p>}
      {message && (
        <>
          <p className="notice">Consensus confirms these bytes on this topic. It does not authenticate the claimed physical seller or prove delivery or payment.</p>
          <dl className="details">
            <div><dt>Topic</dt><dd>{message.topicId}</dd></div>
            <div><dt>Payer</dt><dd>{message.payerAccountId}</dd></div>
            <div><dt>Consensus time</dt><dd>{message.consensusTimestamp}</dd></div>
            <div><dt>Sequence</dt><dd>{message.sequenceNumber}</dd></div>
            <div><dt>Payload bytes</dt><dd>{message.bytes.length}</dd></div>
            <div><dt>SHA-256</dt><dd className="mono">{createHash("sha256").update(message.bytes).digest("hex")}</dd></div>
          </dl>
          <a href={`https://hashscan.io/${config.network}/topic/${message.topicId}`} target="_blank" rel="noreferrer">View topic on HashScan</a>
        </>
      )}
    </section>
  );
}
