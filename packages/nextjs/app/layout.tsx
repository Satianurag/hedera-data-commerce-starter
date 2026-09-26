import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./style.css";

export const metadata: Metadata = {
  title: "Neuron Customer App",
  description: "Inspect live Neuron services and Hedera evidence",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link href="/" className="brand">Neuron Customer App</Link>
          <nav aria-label="Main navigation">
            <Link href="/services">Services</Link>
            <Link href="/sessions">Testnet stream</Link>
            <Link href="/evidence">HCS evidence</Link>
          </nav>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
