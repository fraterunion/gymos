import type { Metadata } from 'next';
import Link from 'next/link';

import { AresMark } from '@/components/AresMark';

export const metadata: Metadata = {
  title: 'ARES Training Club',
  description:
    'Performance training, memberships, bookings, and check-ins — all in one mobile experience.',
  alternates: {
    canonical: '/',
  },
};

const LINKS = [
  {
    href: '/privacy',
    title: 'Privacy Policy',
    description: 'How we collect, use, and protect your information.',
  },
  {
    href: '/support',
    title: 'Support',
    description: 'Get help with login, memberships, bookings, and check-ins.',
  },
  {
    href: '/terms',
    title: 'Terms of Service',
    description: 'Rules and responsibilities for using the ARES mobile app.',
  },
] as const;

export default function HomePage() {
  return (
    <section className="hero">
      <div className="hero-mark">
        <AresMark size={72} priority />
      </div>
      <p className="eyebrow">Ares Training Club</p>
      <h1>ARES Training Club</h1>
      <p>
        Performance training, memberships, bookings, and check-ins — all in one mobile
        experience.
      </p>

      <div className="card-grid">
        {LINKS.map((item) => (
          <Link key={item.href} href={item.href} className="link-card">
            <div>
              <strong>{item.title}</strong>
              <span>{item.description}</span>
            </div>
            <span className="link-card-arrow" aria-hidden>
              →
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
