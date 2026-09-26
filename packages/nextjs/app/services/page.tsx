import Link from "next/link";
import { listLegacyDevices, networkConfigFromEnv } from "@neuron/hedera";
import ServiceCheckUnavailable from "./unavailable";

export const dynamic = "force-dynamic";

export default async function ServicesPage() {
  const config = networkConfigFromEnv(process.env);
  if (!config.legacyDirectoryUrl) {
    return (
      <section>
        <p className="eyebrow">Hedera {config.network}</p>
        <h1>Legacy directory unavailable</h1>
        <p>No approved legacy Neuron directory is available for this network.</p>
      </section>
    );
  }
  let devices: Awaited<ReturnType<typeof listLegacyDevices>>;
  try {
    devices = await listLegacyDevices(config);
  } catch {
    return <ServiceCheckUnavailable />;
  }
  return (
    <section>
      <p className="eyebrow">Hedera {config.network} · Legacy directory</p>
      <h1>Services</h1>
      <p>{devices.length} directory records returned by the live Neuron explorer. Select a device to check its account and HCS topics against Mirror Node.</p>
      <p className="notice">This directory uses the older Neuron protocol. Its listed fee has no verified checkout unit, and records are not signed Agent Cards.</p>
      <ul className="service-list">
        {devices.map(device => (
          <li key={device.accountId}>
            <Link href={`/services/${device.accountId}`}>
              <strong>{device.name || device.accountId}</strong>
              <span>{device.deviceType} · {device.accountId} · Service {device.serviceIds.join(", ")}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
