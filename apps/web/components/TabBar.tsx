"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/chart", icon: "📈", label: "차트" },
  { href: "/signals", icon: "🔔", label: "신호" },
  { href: "/positions", icon: "💼", label: "포지션" },
  { href: "/news", icon: "📰", label: "뉴스" },
  { href: "/settings", icon: "⚙️", label: "설정" },
];

export default function TabBar() {
  const pathname = usePathname();
  if (pathname === "/login") return null;
  return (
    <nav className="tabbar">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} className={pathname.startsWith(t.href) ? "active" : ""}>
          <span>{t.icon}</span>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
