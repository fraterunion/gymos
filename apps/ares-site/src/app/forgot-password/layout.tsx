import type { Metadata } from 'next';

/** Public recovery page: useful to members, never to search engines. */
export const metadata: Metadata = {
  title: 'Recuperar contraseña',
  robots: { index: false, follow: false },
};

export default function ForgotPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
