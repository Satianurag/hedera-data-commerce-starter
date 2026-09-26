export default function ServiceLoading() {
  return <section aria-busy="true">
    <p className="eyebrow">Service identity</p>
    <h1>Checking this service</h1>
    <p role="status">Checking the directory account key and topics against Hedera Mirror Node.</p>
  </section>;
}
