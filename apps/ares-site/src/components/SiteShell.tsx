import Link from 'next/link';
import type { ReactNode } from 'react';

import { AresMark } from '@/components/AresMark';

const NAV_LINKS = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/support', label: 'Support' },
  { href: '/terms', label: 'Terms' },
  { href: '/account-deletion', label: 'Account Deletion' },
] as const;

type Props = {
  children: ReactNode;
};

export function SiteShell({ children }: Props) {
  return (
    <div className="site-shell">
      <header className="site-header">
        <div className="site-header-inner">
          <Link href="/" className="brand-lockup" aria-label="ARES Training Club home">
            <AresMark size={36} />
            <span className="brand-name">ARES</span>
          </Link>
          <nav className="site-nav" aria-label="Legal and support">
            {NAV_LINKS.map((item) => (
              <Link key={item.href} href={item.href}>
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className="site-main">{children}</main>

      <footer className="site-footer">
        <div className="site-footer-inner">
          <span>Powered by FraterUnion</span>
          <nav className="site-nav" aria-label="Footer">
            {NAV_LINKS.map((item) => (
              <Link key={item.href} href={item.href}>
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </footer>
    </div>
  );
}
