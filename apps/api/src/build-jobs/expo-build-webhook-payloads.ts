/**
 * Narrow shape for Expo EAS **build** webhook JSON (POST body).
 * @see https://docs.expo.dev/eas/webhooks/
 */
export type ExpoBuildWebhookPayload = {
  id: string;
  status: string;
  platform?: string;
  buildDetailsPageUrl?: string;
  submissionDetailsPageUrl?: string;
  artifacts?: {
    buildUrl?: string | null;
    applicationArchiveUrl?: string | null;
    logsS3KeyPrefix?: string | null;
  };
  error?: {
    message?: string;
    errorCode?: string;
  };
  completedAt?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
};

export function parseExpoBuildWebhookPayload(raw: unknown): ExpoBuildWebhookPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || o['id'].trim() === '') return null;
  if (typeof o['status'] !== 'string' || o['status'].trim() === '') return null;
  return raw as ExpoBuildWebhookPayload;
}

/** Submit webhooks include submissionDetailsPageUrl; build webhooks include buildDetailsPageUrl. */
export function isExpoBuildWebhookPayload(payload: ExpoBuildWebhookPayload): boolean {
  if (payload.submissionDetailsPageUrl) return false;
  if (payload.buildDetailsPageUrl) return true;
  return !payload.submissionDetailsPageUrl;
}
