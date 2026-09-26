import Link from "next/link";

export default function ServiceNotFound() {
  return <section>
    <p className="eyebrow">Service unavailable</p>
    <h1>This account is not in the current directory.</h1>
    <p>The live legacy directory did not return a matching record. It may have changed since you opened the link.</p>
    <Link className="button secondary" href="/services">Browse current services</Link>
  </section>;
}
