import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Account Deletion Request',
  description:
    'Learn how to request permanent deletion of your ARES Training Club account, what information is deleted, what records may be retained, and how long the process takes.',
  alternates: {
    canonical: '/account-deletion',
  },
};

const SUPPORT_EMAIL = 'support@arestrainingclub.com';
const DELETION_MAILTO = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Account Deletion Request')}`;

export default function AccountDeletionPage() {
  return (
    <>
      <header className="page-header">
        <h1>Account Deletion Request</h1>
        <p>
          Users may request permanent deletion of their ARES Training Club account at any time.
          This page explains how to submit a request, what happens to your data, and how long
          processing typically takes.
        </p>
      </header>

      <article className="content-card">
        <h2>How to request deletion</h2>
        <ol className="numbered-steps">
          <li>
            Send an email to{' '}
            <a href={DELETION_MAILTO}>{SUPPORT_EMAIL}</a>.
          </li>
          <li>Include the email address associated with your ARES account.</li>
          <li>Clearly state that you are requesting permanent account deletion.</li>
          <li>
            We may ask for additional information to verify your identity and protect your account.
          </li>
          <li>
            Once your identity is verified, we will process the request within approximately 30
            days.
          </li>
        </ol>

        <h2>What we delete</h2>
        <p>When an account is deleted:</p>
        <ul>
          <li>Personal profile information is deleted.</li>
          <li>Authentication credentials and active sessions are deleted.</li>
          <li>
            Reservations, waitlist records, and check-in history are deleted or anonymized, unless
            retention is required by law.
          </li>
          <li>
            Membership-related operational data is deleted or anonymized where legally permitted.
          </li>
          <li>Marketing preferences and communication settings are deleted.</li>
        </ul>

        <h2>What we may retain</h2>
        <p>
          Certain records may be retained when required for legal, accounting, tax,
          fraud-prevention, dispute-resolution, or regulatory obligations. This may include:
        </p>
        <ul>
          <li>Payment and transaction records</li>
          <li>Invoices and billing records</li>
          <li>Tax records</li>
          <li>Records required to establish, exercise, or defend legal claims</li>
          <li>Audit logs or fraud-prevention records where required</li>
        </ul>
        <p>
          Any retained information remains limited to the purpose for which retention is legally
          required and will not be used for marketing.
        </p>

        <h2>Processing time</h2>
        <p>
          Account deletion requests are generally completed within 30 days after identity
          verification.
        </p>
        <p>
          In some cases, additional time may be required due to legal, security, or regulatory
          obligations. If this happens, you will be notified.
        </p>

        <h2>Important note</h2>
        <p>
          Account deletion is permanent. After completion, you may no longer have access to your
          account, membership history, reservations, or associated app data.
        </p>

        <h2>Contact</h2>
        <p>
          To start a deletion request, email{' '}
          <a href={DELETION_MAILTO}>{SUPPORT_EMAIL}</a>.
        </p>
        <p className="contact-line">
          <a href={DELETION_MAILTO} className="cta-button">
            Request account deletion
          </a>
        </p>
      </article>
    </>
  );
}
