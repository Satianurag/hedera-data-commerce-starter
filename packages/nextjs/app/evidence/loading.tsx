export default function EvidenceLoading() {
  return (
    <section aria-busy="true">
      <p className="eyebrow">HCS evidence</p>
      <h1>Checking topic evidence</h1>
      <p role="status">
        Reading Hedera Mirror Node. No topic message is confirmed by this view yet.
      </p>
    </section>
  );
}
