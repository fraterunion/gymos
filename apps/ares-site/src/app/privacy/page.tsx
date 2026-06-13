import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    'Privacy Policy for the ARES Training Club mobile app — account data, memberships, bookings, payments, and check-ins.',
  alternates: {
    canonical: '/privacy',
  },
};

const CONTACT_EMAIL = 'support@fraterunion.com';

export default function PrivacyPage() {
  return (
    <>
      <header className="page-header">
        <h1>Privacy Policy</h1>
        <p>Last updated: June 12, 2026</p>
      </header>

      <article className="content-card">
        <p>
          This Privacy Policy describes how ARES Training Club (&quot;ARES,&quot; &quot;we,&quot;
          &quot;us,&quot; or &quot;our&quot;) collects, uses, and protects information when you use
          the ARES mobile application and related services operated for Ares Training Club.
        </p>

        <h2>Information We Collect</h2>
        <ul>
          <li>
            <strong>Account information:</strong> When you create an account, we collect your name,
            email address, and other profile details needed to identify you within the studio.
          </li>
          <li>
            <strong>Membership and booking data:</strong> We store membership status, class
            bookings, attendance history, and related studio activity connected to your account.
          </li>
          <li>
            <strong>Payment information:</strong> Membership and billing payments are processed by
            Stripe. We do not store full payment card numbers on our servers. Stripe handles card
            data according to its own privacy policy.
          </li>
          <li>
            <strong>QR check-ins and attendance:</strong> When you check in to a class, we record
            attendance tied to your booking, including check-in time and method (such as QR scan or
            staff-assisted check-in).
          </li>
          <li>
            <strong>Device and camera permission:</strong> The app may request camera access only
            for authorized staff members to scan member QR codes at the front desk. Members are not
            required to grant camera access for normal app use.
          </li>
          <li>
            <strong>Analytics and diagnostics:</strong> We may collect limited technical
            information such as app version, device type, and error logs to keep the service
            reliable and secure.
          </li>
        </ul>

        <h2>How We Use Information</h2>
        <ul>
          <li>Provide memberships, class bookings, attendance, and account access.</li>
          <li>Process payments and manage billing through Stripe.</li>
          <li>Operate staff check-in tools and studio operations.</li>
          <li>Improve app performance, security, and support.</li>
          <li>Communicate with you about your account, bookings, or support requests.</li>
        </ul>

        <h2>How We Share Information</h2>
        <p>We do not sell your personal information. We may share data only:</p>
        <ul>
          <li>With service providers that help us operate the app (such as Stripe for payments).</li>
          <li>With the studio operating Ares Training Club for legitimate business operations.</li>
          <li>When required by law or to protect the rights, safety, and security of users.</li>
        </ul>

        <h2>Data Retention and Deletion</h2>
        <p>
          We retain account and activity data for as long as needed to provide the service, comply
          with legal obligations, and resolve disputes. You may request access, correction, or
          deletion of your personal information by contacting us.
        </p>

        <h2>Security</h2>
        <p>
          We use reasonable administrative, technical, and organizational safeguards designed to
          protect your information. No method of transmission or storage is completely secure.
        </p>

        <h2>Children&apos;s Privacy</h2>
        <p>
          The app is not directed to children under 13, and we do not knowingly collect personal
          information from children under 13.
        </p>

        <h2>Changes to This Policy</h2>
        <p>
          We may update this Privacy Policy from time to time. We will post the updated version on
          this page with a revised date.
        </p>

        <h2>Contact</h2>
        <p className="contact-line">
          Questions about this Privacy Policy or your data? Email{' '}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>
      </article>
    </>
  );
}
