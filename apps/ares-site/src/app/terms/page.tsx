import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description:
    'Terms of Service for the ARES Training Club mobile app — memberships, bookings, payments, and account use.',
  alternates: {
    canonical: '/terms',
  },
};

const CONTACT_EMAIL = 'support@fraterunion.com';

export default function TermsPage() {
  return (
    <>
      <header className="page-header">
        <h1>Terms of Service</h1>
        <p>Last updated: June 12, 2026</p>
      </header>

      <article className="content-card">
        <p>
          These Terms of Service (&quot;Terms&quot;) govern your use of the ARES Training Club mobile
          application and related services (the &quot;App&quot;). By creating an account or using the
          App, you agree to these Terms.
        </p>

        <h2>Use of the App</h2>
        <p>
          The App is provided to help members and authorized staff manage memberships, book classes,
          check in to sessions, and access studio-related features. You agree to use the App only for
          lawful purposes and in accordance with studio policies.
        </p>

        <h2>Memberships and Bookings</h2>
        <ul>
          <li>Class availability, schedules, and booking rules are set by Ares Training Club.</li>
          <li>Bookings may be subject to cancellation windows, capacity limits, and studio policies.</li>
          <li>We may modify or discontinue features with reasonable notice when practical.</li>
        </ul>

        <h2>Payments</h2>
        <p>
          Membership and billing payments are processed by Stripe. By making a payment through the
          App, you also agree to Stripe&apos;s applicable terms and policies. Prices, renewals, and
          refunds are governed by studio membership rules unless otherwise required by law.
        </p>

        <h2>Studio Rules</h2>
        <p>
          Gym rules, class policies, code of conduct, and operational decisions are controlled by the
          studio operating Ares Training Club. The App is a tool for accessing those services and
          does not replace in-studio policies or staff instructions.
        </p>

        <h2>Account Responsibility</h2>
        <ul>
          <li>You are responsible for maintaining the confidentiality of your login credentials.</li>
          <li>You are responsible for activity that occurs under your account.</li>
          <li>You agree to provide accurate account information and keep it up to date.</li>
          <li>Staff accounts must be used only by authorized personnel for legitimate studio operations.</li>
        </ul>

        <h2>Prohibited Conduct</h2>
        <ul>
          <li>Attempting to access another user&apos;s account without authorization.</li>
          <li>Interfering with app security, check-in systems, or studio operations.</li>
          <li>Using the App in a way that harms other members, staff, or the studio.</li>
        </ul>

        <h2>Disclaimers</h2>
        <p>
          The App is provided on an &quot;as is&quot; and &quot;as available&quot; basis. Training
          activities involve inherent risks. You are responsible for consulting qualified professionals
          and following studio safety guidance before participating in physical training.
        </p>

        <h2>Limitation of Liability</h2>
        <p>
          To the fullest extent permitted by law, ARES Training Club and its operators will not be
          liable for indirect, incidental, special, consequential, or punitive damages arising from
          your use of the App. Our total liability for any claim related to the App will not exceed
          the amount you paid for the affected membership or booking in the twelve months before the
          claim, unless a greater limitation is prohibited by law.
        </p>

        <h2>Termination</h2>
        <p>
          We may suspend or terminate access to the App if you violate these Terms, misuse the
          service, or if required for security or legal reasons. You may stop using the App at any
          time by deleting the application from your device and contacting support regarding your
          account.
        </p>

        <h2>Changes</h2>
        <p>
          We may update these Terms from time to time. Continued use of the App after changes become
          effective constitutes acceptance of the revised Terms.
        </p>

        <h2>Contact</h2>
        <p className="contact-line">
          Questions about these Terms? Email{' '}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>
      </article>
    </>
  );
}
