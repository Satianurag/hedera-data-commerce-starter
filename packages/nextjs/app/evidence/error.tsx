"use client";

import Link from "next/link";

export default function EvidenceError({ reset }: { error: Error; reset: () => void }) {
  return (
    <section>
      <p className="eyebrow">HCS evidence unavailable</p>
      <h1>We could not load this evidence view.</h1>
      <p className="notice" role="alert">
        No topic message or signature is verified from this attempt.
      </p>
      <div className="actions">
        <button type="button" onClick={reset}>
          Retry this view
        </button>
        <Link className="button secondary" href="/evidence">
          Inspect another topic
        </Link>
      </div>
    </section>
  );
}
