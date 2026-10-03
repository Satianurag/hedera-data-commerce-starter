import Link from "next/link";
import { listLegacyDevices, networkConfigFromEnv } from "@neuron/hedera";
import ServiceCheckUnavailable from "./unavailable";
import { streamOptionSeller } from "./stream-option";

export const dynamic = "force-dynamic";

const pageSize = 24;

function selectedPage(raw: string | string[] | undefined, totalPages: number): number {
  if (typeof raw !== "string" || !/^[1-9]\d{0,5}$/.test(raw)) return 1;
  return Math.min(Number(raw), Math.max(totalPages, 1));
}

export default async function ServicesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const config = networkConfigFromEnv(process.env);
  const streamSeller = streamOptionSeller(config.network, process.env);
  if (!config.legacyDirectoryUrl) {
    return (
      <section>
        <p className="eyebrow">Hedera {config.network}</p>
        <h1>No service directory configured</h1>
        <p>
          No approved legacy Neuron directory is available for this network. There are no services
          to inspect here yet.
        </p>
      </section>
    );
  }
  let devices: Awaited<ReturnType<typeof listLegacyDevices>>;
  try {
    devices = await listLegacyDevices(config);
  } catch {
    return <ServiceCheckUnavailable />;
  }

  const totalPages = Math.ceil(devices.length / pageSize);
  const page = selectedPage((await searchParams).page, totalPages);
  const start = (page - 1) * pageSize;
  const shown = devices.slice(start, start + pageSize);

  return (
    <section>
      <p className="eyebrow">Hedera {config.network} · Legacy directory</p>
      <h1>Services</h1>
      <p>
        Browse services listed by the live Neuron legacy directory. Open a record to check its
        account key and HCS topics against Hedera Mirror Node.
      </p>
      <p className="notice">
        These are directory claims, not signed Agent Cards. A listed service is not yet identity
        checked or streaming. This deployment selects at most one seller for its stream path. The
        legacy fee is not a verified checkout price.
      </p>
      {devices.length === 0 ? (
        <p role="status">The directory returned no service records for this network.</p>
      ) : (
        <>
          <p role="status">
            Showing {start + 1}–{start + shown.length} of {devices.length} directory records. Page{" "}
            {page} of {totalPages}.
          </p>
          <ul className="service-list">
            {shown.map((device, index) => (
              <li key={`${device.accountId}-${start + index}`}>
                <Link href={`/services/${device.accountId}`}>
                  <strong>{(device.name.trim() || device.accountId).slice(0, 120)}</strong>
                  <span>Directory listed · Identity unchecked</span>
                  <span>
                    {device.accountId === streamSeller
                      ? "Selected stream path · connection unverified"
                      : "Directory only · no stream path selected here"}
                  </span>
                  <span>
                    {device.deviceType.slice(0, 80)} · Account {device.accountId}
                  </span>
                  <span>
                    {device.serviceIds.length} advertised service
                    {device.serviceIds.length === 1 ? "" : "s"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {totalPages > 1 && (
            <nav className="actions" aria-label="Service pages">
              {page > 1 && (
                <Link className="button secondary" href={`/services?page=${page - 1}`}>
                  Previous page
                </Link>
              )}
              {page < totalPages && (
                <Link className="button secondary" href={`/services?page=${page + 1}`}>
                  Next page
                </Link>
              )}
            </nav>
          )}
        </>
      )}
    </section>
  );
}
