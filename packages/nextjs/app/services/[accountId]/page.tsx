import Link from "next/link";
import { notFound } from "next/navigation";
import { checkLegacyDeviceBinding, getLatestTopicMessage, listLegacyDevices, networkConfigFromEnv } from "@neuron/hedera";

export const dynamic = "force-dynamic";

export default async function ServicePage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const config = networkConfigFromEnv(process.env);
  const devices = await listLegacyDevices(config);
  const device = devices.find(row => row.accountId === accountId);
  if (!device) notFound();

  await checkLegacyDeviceBinding(config, device);
  const latest = await getLatestTopicMessage(config, device.stdoutTopicId);
  const sellerPaidLatest = latest?.payerAccountId === device.accountId;
  let messageType: string | undefined;
  let protocolVersion: string | undefined;
  if (latest && sellerPaidLatest) {
    try {
      const body: unknown = JSON.parse(Buffer.from(latest.bytes).toString("utf8"));
      if (body && typeof body === "object") {
        const fields = body as Record<string, unknown>;
        if (typeof fields.messageType === "string") messageType = fields.messageType;
        if (typeof fields.version === "string") protocolVersion = fields.version;
      }
    } catch {
      // Public topic bytes may use a non-JSON protocol.
    }
  }

  return (
    <section>
      <p className="eyebrow">Hedera {config.network} · Legacy directory</p>
      <h1>{device.name || device.accountId}</h1>
      <p>{device.deviceType} · Account {device.accountId}</p>
      <p className="notice">Mirror Node confirms this directory key matches the account key and both topics exist. The directory entry and heartbeat remain unverified as a signed Agent Card or active data stream.</p>
      {latest && !sellerPaidLatest && <p className="notice">The latest public-topic message was paid by another account. Its contents are not attributed to this seller.</p>}
      <dl className="details">
        <div><dt>Services</dt><dd>{device.serviceIds.join(", ")}</dd></div>
        <div><dt>Seller stdin</dt><dd>{device.stdinTopicId}</dd></div>
        <div><dt>Seller stdout</dt><dd>{device.stdoutTopicId}</dd></div>
        <div><dt>Latest HCS message</dt><dd>{sellerPaidLatest ? (messageType ?? "Binary or unknown format") : (latest ? "Paid by another account" : "No messages")}</dd></div>
        {latest && <div><dt>Latest HCS payer</dt><dd>{latest.payerAccountId}</dd></div>}
        {protocolVersion && <div><dt>Payer-matched message version</dt><dd>{protocolVersion}</dd></div>}
        {latest && <div><dt>Consensus time</dt><dd>{new Date(Number(latest.consensusTimestamp) * 1000).toISOString()}</dd></div>}
        {latest && <div><dt>Sequence</dt><dd>{latest.sequenceNumber}</dd></div>}
      </dl>
      <Link className="button" href={`/evidence?topic=${device.stdoutTopicId}`}>Inspect HCS evidence</Link>
    </section>
  );
}
