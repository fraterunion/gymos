import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Support',
  description:
    'ARES Training Club Support — help with login, memberships, billing, bookings, and QR check-in.',
  alternates: {
    canonical: '/support',
  },
};

const CONTACT_EMAIL = 'support@fraterunion.com';

const TOPICS = [
  'Login help',
  'Memberships and billing',
  'Booking classes',
  'QR check-in',
  'Staff scanner',
] as const;

export default function SupportPage() {
  return (
    <>
      <header className="page-header">
        <h1>ARES Training Club Support</h1>
        <p>
          Need help with the ARES mobile app? Reach out and we&apos;ll get you back on track.
        </p>
      </header>

      <article className="content-card">
        <h2>Contact</h2>
        <p className="contact-line">
          Email us at <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>
        <p>We usually respond within 1–2 business days.</p>

        <h2>Common Topics</h2>
        <ul className="topic-list">
          {TOPICS.map((topic) => (
            <li key={topic}>{topic}</li>
          ))}
        </ul>

        <h2>Before You Write</h2>
        <p>
          Include the email address on your account, a brief description of the issue, and your
          device type (iPhone or Android). For billing questions, mention whether the issue relates
          to membership renewal, payment failure, or booking access.
        </p>
      </article>
    </>
  );
}
