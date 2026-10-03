import { createHash } from "node:crypto";
import {
  getLatestTopicMessage,
  getMirrorAccount,
  inspectSignedTopicEnvelope,
  networkConfigFromEnv,
} from "@neuron/hedera";
import type { SignedTopicEnvelope } from "@neuron/hedera";

export const dynamic = "force-dynamic";

export default async function EvidencePage({
  searchParams,
}: {
  searchParams: Promise<{ topic?: string | string[] }>;
}) {
  const rawTopic = (await searchParams).topic;
  const topic = typeof rawTopic === "string" ? rawTopic.trim() : undefined;
  const config = networkConfigFromEnv(process.env);
  let message: Awaited<ReturnType<typeof getLatestTopicMessage>> = null;
  let error: string | undefined;
  let signed: SignedTopicEnvelope | null = null;
  let signatureError: string | undefined;
  let payerKeyMatches: boolean | undefined;
  if (rawTopic !== undefined && (!topic || !/^\d{1,20}\.\d{1,20}\.\d{1,20}$/.test(topic))) {
    error = "Enter one valid Hedera topic ID, such as 0.0.12345.";
  } else if (topic) {
    try {
      message = await getLatestTopicMessage(config, topic);
    } catch {
      error =
        "This topic could not be checked on the selected network. Check the ID and try again.";
    }
  }
  if (message) {
    try {
      signed = inspectSignedTopicEnvelope(message.bytes);
    } catch (cause) {
      signatureError =
        cause instanceof Error ? cause.message : "Signed envelope failed verification";
    }
    if (signed) {
      try {
        const payer = await getMirrorAccount(config, message.payerAccountId);
        payerKeyMatches =
          payer.key?._type === "ECDSA_SECP256K1" &&
          payer.key.key.toLowerCase() === signed.compressedPublicKey.toLowerCase();
      } catch {
        payerKeyMatches = undefined;
      }
    }
  }

  return (
    <section>
      <p className="eyebrow">Hedera {config.network} · Mirror Node</p>
      <h1>HCS evidence</h1>
      <p>
        Look up the newest message on a Hedera topic. Mirror Node can show what was recorded; it
        cannot prove that a seller delivered data or received payment.
      </p>
      <form action="/evidence" className="topic-form">
        <label htmlFor="topic">Topic ID</label>
        <input
          id="topic"
          name="topic"
          defaultValue={topic ?? ""}
          placeholder="0.0.12345"
          maxLength={62}
          required
        />
        <button type="submit">Inspect</button>
      </form>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {!rawTopic && <p role="status">Enter a topic ID to inspect its latest recorded message.</p>}
      {topic && !error && !message && (
        <p role="status">
          The topic exists on Hedera {config.network}, but Mirror Node returned no messages.
        </p>
      )}
      {message && (
        <>
          <p role="status">
            Mirror Node returned the topic metadata and latest message bytes for Hedera{" "}
            {config.network}.
          </p>
          <p className="notice">
            This is a Hedera record, not proof of the physical seller, live data delivery or
            payment.
          </p>
          <dl className="details">
            <div>
              <dt>Topic</dt>
              <dd>{message.topicId}</dd>
            </div>
            <div>
              <dt>Payer</dt>
              <dd>{message.payerAccountId}</dd>
            </div>
            <div>
              <dt>Consensus time</dt>
              <dd>{message.consensusTimestamp}</dd>
            </div>
            <div>
              <dt>Sequence</dt>
              <dd>{message.sequenceNumber}</dd>
            </div>
            <div>
              <dt>Payload bytes</dt>
              <dd>{message.bytes.length}</dd>
            </div>
            <div>
              <dt>SHA-256</dt>
              <dd className="mono">{createHash("sha256").update(message.bytes).digest("hex")}</dd>
            </div>
          </dl>
          {!signed && !signatureError && (
            <p className="notice">
              No draft Neuron signed TopicMessage envelope was detected in these bytes. No message
              signature is verified.
            </p>
          )}
          {signatureError && (
            <p className="notice" role="alert">
              A signed Neuron topic envelope was detected but rejected:{" "}
              {signatureError.slice(0, 160)}
            </p>
          )}
          {signed && (
            <>
              <p className="notice">
                The draft Neuron topic signature verifies for the address below.{" "}
                {payerKeyMatches === true
                  ? "Its recovered key also matches the HCS payer account's current Mirror key."
                  : payerKeyMatches === false
                    ? "Its signer differs from the payer account's current Mirror key."
                    : "The payer account key could not be checked."}{" "}
                This does not establish a seller registration, delivery or payment.
              </p>
              <dl className="details">
                <div>
                  <dt>Signed sender</dt>
                  <dd>{signed.senderAddress}</dd>
                </div>
                <div>
                  <dt>Sender timestamp (ns)</dt>
                  <dd>{signed.timestamp.toString()}</dd>
                </div>
                <div>
                  <dt>Sender sequence</dt>
                  <dd>{signed.sequenceNumber.toString()}</dd>
                </div>
                <div>
                  <dt>Signed payload SHA-256</dt>
                  <dd className="mono">
                    {createHash("sha256").update(signed.payload).digest("hex")}
                  </dd>
                </div>
              </dl>
            </>
          )}
          <a
            href={`https://hashscan.io/${config.network}/topic/${message.topicId}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            View topic on HashScan
          </a>
        </>
      )}
    </section>
  );
}
