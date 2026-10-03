import Link from "next/link";
import { notFound } from "next/navigation";
import {
  checkLegacyDeviceBinding,
  getLatestTopicMessage,
  listLegacyDevices,
  networkConfigFromEnv,
} from "@neuron/hedera";
import ServiceCheckUnavailable from "../unavailable";
import { streamOptionSeller } from "../stream-option";

export const dynamic = "force-dynamic";

export default async function ServicePage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  if (!/^0\.0\.[1-9]\d{0,18}$/.test(accountId)) notFound();
  const config = networkConfigFromEnv(process.env);
  const streamConfigured = streamOptionSeller(config.network, process.env) === accountId;
  let devices: Awaited<ReturnType<typeof listLegacyDevices>>;
  try {
    devices = await listLegacyDevices(config);
  } catch {
    return <ServiceCheckUnavailable />;
  }
  const matches = devices.filter((row) => row.accountId === accountId);
  if (matches.length === 0) notFound();
  if (matches.length > 1) {
    return (
      <section>
        <p className="eyebrow">Hedera {config.network} · Legacy directory</p>
        <h1>Conflicting service records</h1>
        <p className="notice" role="alert">
          The directory returned multiple records for account {accountId}. This view cannot choose a
          seller identity or topic from them.
        </p>
        <Link className="button secondary" href="/services">
          Back to services
        </Link>
      </section>
    );
  }
  const device = matches[0];

  let latest: Awaited<ReturnType<typeof getLatestTopicMessage>>;
  try {
    await checkLegacyDeviceBinding(config, device);
    latest = await getLatestTopicMessage(config, device.stdoutTopicId);
  } catch {
    return <ServiceCheckUnavailable />;
  }
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
  const displayedServices = device.serviceIds.slice(0, 20).join(", ");
  const extraServices = Math.max(device.serviceIds.length - 20, 0);
  const consensusDate = latest ? new Date(Number(latest.consensusTimestamp) * 1000) : null;
  const consensusTime =
    consensusDate && Number.isFinite(consensusDate.getTime())
      ? consensusDate.toISOString()
      : latest?.consensusTimestamp;

  return (
    <section>
      <p className="eyebrow">Hedera {config.network} · Legacy directory</p>
      <h1>{(device.name.trim() || device.accountId).slice(0, 120)}</h1>
      <p>
        {device.deviceType.slice(0, 80)} · Account {device.accountId}
      </p>
      <p role="status">
        Account and topic binding checked on Hedera {config.network}.{" "}
        {streamConfigured
          ? "This seller is selected for this deployment's stream path; connection and data delivery are not checked here."
          : "No stream path is selected for this seller in this deployment. You can inspect its public HCS evidence."}
      </p>
      <p className="notice">
        Mirror Node confirms that this directory key matches the account key and both topics exist.
        This does not turn the directory record into a signed Agent Card or prove that data is
        arriving.
      </p>
      {latest && !sellerPaidLatest && (
        <p className="notice">
          The newest public-topic message was paid by another account. Its contents are not
          attributed to this seller.
        </p>
      )}
      {!latest && (
        <p role="status">
          The seller&apos;s stdout topic exists, but Mirror Node returned no messages.
        </p>
      )}
      <dl className="details">
        <div>
          <dt>Directory source</dt>
          <dd>Public legacy directory; unsigned record</dd>
        </div>
        <div>
          <dt>Advertised services</dt>
          <dd>
            {displayedServices || "None listed"}
            {extraServices > 0 && `, and ${extraServices} more`}
          </dd>
        </div>
        <div>
          <dt>Seller stdin</dt>
          <dd>{device.stdinTopicId}</dd>
        </div>
        <div>
          <dt>Seller stdout</dt>
          <dd>{device.stdoutTopicId}</dd>
        </div>
        <div>
          <dt>Latest HCS message</dt>
          <dd>
            {sellerPaidLatest
              ? (messageType?.slice(0, 80) ?? "Binary or unknown format")
              : latest
                ? "Paid by another account"
                : "No messages"}
          </dd>
        </div>
        {latest && (
          <div>
            <dt>Latest HCS payer</dt>
            <dd>{latest.payerAccountId}</dd>
          </div>
        )}
        {protocolVersion && (
          <div>
            <dt>Payer-matched message version</dt>
            <dd>{protocolVersion.slice(0, 80)}</dd>
          </div>
        )}
        {latest && (
          <div>
            <dt>Consensus time</dt>
            <dd>{consensusTime}</dd>
          </div>
        )}
        {latest && (
          <div>
            <dt>Sequence</dt>
            <dd>{latest.sequenceNumber}</dd>
          </div>
        )}
      </dl>
      <div className="actions">
        {streamConfigured && (
          <Link
            className="button"
            href={`/sessions?seller=${encodeURIComponent(device.accountId)}`}
          >
            Open this seller&apos;s stream
          </Link>
        )}
        <Link className="button" href={`/evidence?topic=${device.stdoutTopicId}`}>
          Inspect HCS evidence
        </Link>
        <Link className="button secondary" href="/services">
          Back to services
        </Link>
      </div>
    </section>
  );
}
