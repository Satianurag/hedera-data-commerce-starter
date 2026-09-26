import Link from "next/link";

export default function ServiceCheckUnavailable() {
  return <section>
    <p className="eyebrow">Service check unavailable</p>
    <h1>We could not check the live service records.</h1>
    <p className="notice" role="alert">The directory or Hedera account and topic checks did not complete. No seller identity or stream status is verified from this attempt.</p>
    <Link className="button" href="/services" prefetch={false}>Retry live check</Link>
  </section>;
}
