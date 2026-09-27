import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import SiteNav from "./_components/site-nav";
import "./style.css";

export const metadata: Metadata = {
  title: "Neuron × Scaffold-HBAR | Developer Template",
  description: "A reusable Neuron customer application template with Hedera service discovery, wallet sessions, file delivery and explicit payment flows.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main-content" className="skip-link">Skip to content</a>
        <header className="site-header">
          <div className="header-inner">
            <div className="brand-row">
              <Link href="/" className="brand"><span className="brand-mark" aria-hidden="true">N</span><span>Neuron <span className="brand-divider">/</span> Scaffold-HBAR</span></Link>
              <span className="template-label">Developer template</span>
            </div>
            <SiteNav />
          </div>
        </header>
        <main className="container" id="main-content" tabIndex={-1}>{children}</main>
        <footer className="site-footer">
          <p>Neuron × Scaffold-HBAR <span>Build on the examples. Make it yours.</span></p>
          <nav aria-label="Developer resources">
            <a href="https://nextjs.org/docs">Next.js</a>
            <a href="https://docs.hedera.com/">Hedera</a>
            <a href="https://github.com/NeuronInnovations/neuron-specs">Neuron specs</a>
          </nav>
        </footer>
      </body>
    </html>
  );
}
