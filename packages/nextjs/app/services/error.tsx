"use client";

export default function ServicesError({ reset }: { error: Error; reset: () => void }) {
  return <section>
    <p className="eyebrow">Service check unavailable</p>
    <h1>We could not check the live service records.</h1>
    <p className="notice" role="alert">The directory or Hedera account and topic checks did not complete. No seller identity or stream status is verified from this attempt.</p>
    <button type="button" onClick={reset}>Retry live check</button>
  </section>;
}
