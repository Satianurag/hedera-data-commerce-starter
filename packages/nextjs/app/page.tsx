import Link from "next/link";
import { networkConfigFromEnv } from "@neuron/hedera";

export const dynamic = "force-dynamic";

const examples = [
  {
    number: "01",
    title: "Discover services",
    description:
      "Read the live legacy directory and inspect seller accounts and topics through Hedera Mirror Node.",
    detail: "Read-only · directory claims are labelled",
    href: "/services",
  },
  {
    number: "02",
    title: "Receive a file",
    description:
      "Follow a signed agreement through file delivery, explicit ERC20 payment approval and deadline recovery.",
    detail: "Testnet · pinned Neuron reference protocol",
    href: "/reference",
  },
  {
    number: "03",
    title: "Inspect the evidence",
    description:
      "Look up real HCS records, reassemble message bytes and inspect the sender of a signed envelope.",
    detail: "Read-only · selected network",
    href: "/evidence",
  },
] as const;

export default function HomePage() {
  const config = networkConfigFromEnv(process.env);

  return (
    <>
      <section className="starter-hero" aria-labelledby="starter-title">
        <div>
          <p className="eyebrow">Neuron × Scaffold-HBAR</p>
          <h1 id="starter-title">Your next customer app starts here.</h1>
          <p className="hero-description">
            A developer template for Neuron services on Hedera. Start with service discovery, wallet
            sessions, file delivery and verifiable payment flows. Make the application your own.
          </p>
          <div className="actions">
            <Link className="button" href="/services">
              Explore services <span aria-hidden="true">↗</span>
            </Link>
            <a className="button secondary" href="#start-building">
              Start building <span aria-hidden="true">↓</span>
            </a>
          </div>
        </div>

        <aside className="starter-context" aria-labelledby="workspace-title">
          <div className="context-heading">
            <span className="context-mark" aria-hidden="true">
              N
            </span>
            <div>
              <h2 id="workspace-title">One starter. Clear boundaries.</h2>
              <p>Next.js · TypeScript · Foundry · Go</p>
            </div>
          </div>
          <dl className="workspace-map">
            <div>
              <dt>nextjs/</dt>
              <dd>Application &amp; wallet UI</dd>
            </div>
            <div>
              <dt>neuron-hedera/</dt>
              <dd>Network &amp; message adapters</dd>
            </div>
            <div>
              <dt>neuron-go/</dt>
              <dd>HCS writer &amp; live gateway</dd>
            </div>
            <div>
              <dt>neuron-reference/</dt>
              <dd>Reference file service</dd>
            </div>
            <div>
              <dt>foundry/</dt>
              <dd>Native HBAR escrow</dd>
            </div>
          </dl>
          <div className="network-context">
            <span className="network-badge">Hedera {config.network}</span>
            <span>EVM chain {config.chainId}</span>
          </div>
          <p className="context-note">
            No credentials are needed to browse. Transactions and live connections require explicit
            configuration.
          </p>
        </aside>
      </section>

      {config.network === "mainnet" && (
        <p className="notice">
          This deployment selects mainnet for read-only evidence. The service stream and payment
          examples are testnet-only; a mainnet release requires its own resources and verification.
        </p>
      )}

      <section className="starter-section" aria-labelledby="examples-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Explore the building blocks</p>
            <h2 id="examples-title">Working examples you can extend.</h2>
          </div>
          <p>Each example makes its source, network and verification state visible.</p>
        </div>
        <div className="example-list">
          {examples.map((example) => (
            <Link className="example-link" key={example.href} href={example.href}>
              <span className="example-number" aria-hidden="true">
                {example.number}
              </span>
              <div>
                <h3>{example.title}</h3>
                <p>{example.description}</p>
                <span className="example-detail">{example.detail}</span>
              </div>
              <span className="example-arrow" aria-hidden="true">
                ↗
              </span>
            </Link>
          ))}
        </div>
        <p className="supporting-links">
          Also included: <Link href="/sessions">wallet sign-in &amp; legacy streaming</Link> and{" "}
          <Link href="/commerce">native HBAR quote review</Link>. These use separate adapters from
          the reference file service.
        </p>
      </section>

      <section
        className="starter-section build-section"
        id="start-building"
        aria-labelledby="build-title"
      >
        <div>
          <p className="eyebrow">Make it yours</p>
          <h2 id="build-title">
            Start with the code.
            <br />
            Keep the useful parts.
          </h2>
          <p>
            The root <code>README.md</code> covers setup, configuration and deployment. Reads work
            without secrets; enable the integrations your application needs.
          </p>
          <div className="terminal" aria-label="Run the template from the repository root">
            <span>From the repository root</span>
            <pre>
              <code>{"npm ci --engine-strict\nnpm run dev"}</code>
            </pre>
          </div>
        </div>
        <ol className="edit-list">
          <li>
            <h3>Shape your frontend</h3>
            <p>Edit this page, navigation and visual styles.</p>
            <code>packages/nextjs/app/page.tsx</code>
          </li>
          <li>
            <h3>Connect your service</h3>
            <p>Keep network and protocol checks in the shared adapter.</p>
            <code>packages/neuron-hedera/src/</code>
          </li>
          <li>
            <h3>Extend the contract</h3>
            <p>Build on the separate native HBAR escrow example.</p>
            <code>packages/foundry/src/BuyerEscrow.sol</code>
          </li>
        </ol>
      </section>

      <p className="starter-disclaimer">
        Independent template, not an official Neuron release. Directory listings, signed messages,
        delivered bytes and settled payments are separate claims. The examples expose those
        distinctions so your application can too.
      </p>
    </>
  );
}
