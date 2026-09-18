import type { Metadata } from 'next';

/** Public recovery page: useful to members, never to search engines. */
export const metadata: Metadata = {
  title: 'Restablecer contraseña',
  robots: { index: false, follow: false },
};

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
