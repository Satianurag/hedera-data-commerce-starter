"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Overview" },
  { href: "/services", label: "Services" },
  { href: "/reference", label: "File delivery" },
  { href: "/sessions", label: "Stream & wallet" },
  { href: "/commerce", label: "HBAR quotes" },
  { href: "/evidence", label: "HCS evidence" },
] as const;

export default function SiteNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Main navigation" className="site-nav">
      {links.map(({ href, label }) => {
        const active = href === "/" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
        return <Link key={href} href={href} aria-current={active ? "page" : undefined}>{label}</Link>;
      })}
    </nav>
  );
}
