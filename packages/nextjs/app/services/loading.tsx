export default function ServicesLoading() {
  return (
    <section aria-busy="true">
      <p className="eyebrow">Service directory</p>
      <h1>Checking services</h1>
      <p role="status">
        Reading the live directory. Service identities and stream status are not yet checked.
      </p>
    </section>
  );
}
