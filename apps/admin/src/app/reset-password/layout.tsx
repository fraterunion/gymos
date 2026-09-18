import type { Metadata } from "next";

/**
 * The public recovery pages are member-facing and white-label: the root layout's
 * studio-specific title must not appear in a member's browser tab.
 */
export const metadata: Metadata = {
  title: "Restablecer contraseña",
  robots: { index: false, follow: false },
};

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
