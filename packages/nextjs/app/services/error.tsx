"use client";

import ServiceCheckUnavailable from "./unavailable";

export default function ServicesError({ reset }: { error: Error; reset: () => void }) {
  return <div>
    <ServiceCheckUnavailable />
    <button type="button" className="secondary" onClick={reset}>Retry this view</button>
  </div>;
}
