import type { Metadata } from 'next';

import { SiteShell } from '@/components/SiteShell';
import './globals.css';

const SITE_URL = 'https://ares.fraterunion.com';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'ARES Training Club',
    template: '%s · ARES Training Club',
  },
  description:
    'Performance training, memberships, bookings, and check-ins — all in one mobile experience.',
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: SITE_URL,
    siteName: 'ARES Training Club',
    title: 'ARES Training Club',
    description:
      'Performance training, memberships, bookings, and check-ins — all in one mobile experience.',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SiteShell>{children}</SiteShell>
      </body>
    </html>
  );
}
