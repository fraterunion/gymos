import type { EasRemoteBuildStatus } from './eas-status-poller.service';
import type { ExpoBuildWebhookPayload } from './expo-build-webhook-payloads';

/** Expo REST API + webhook statuses normalized to uppercase tokens stored in DB. */
export function normalizeExpoBuildStatus(raw: string): string {
  const key = raw.trim().toLowerCase();
  switch (key) {
    case 'finished':
    case 'finish':
      return 'FINISHED';
    case 'errored':
    case 'error':
      return 'ERRORED';
    case 'canceled':
    case 'cancelled':
      return 'CANCELED';
    case 'new':
      return 'NEW';
    case 'in_queue':
    case 'in-queue':
    case 'inqueue':
      return 'IN_QUEUE';
    case 'in_progress':
    case 'in-progress':
    case 'inprogress':
      return 'IN_PROGRESS';
    case 'submitted':
      return 'SUBMITTED';
    default:
      return raw.trim().toUpperCase();
  }
}

export function isExpoTerminalBuildStatus(status: string): boolean {
  return ['FINISHED', 'ERRORED', 'CANCELED'].includes(normalizeExpoBuildStatus(status));
}

/** Maps a verified Expo **build** webhook body to the shape used by `syncEasBuildStatus`. */
export function webhookPayloadToRemoteStatus(payload: ExpoBuildWebhookPayload): EasRemoteBuildStatus {
  const expoStatus = normalizeExpoBuildStatus(payload.status);
  const artifacts = payload.artifacts;
  const artifactUrl =
    artifacts?.applicationArchiveUrl ??
    artifacts?.buildUrl ??
    null;
  const completedAt =
    typeof payload.completedAt === 'string' && payload.completedAt
      ? new Date(payload.completedAt)
      : null;
  const errorMessage =
    typeof payload.error?.message === 'string' ? payload.error.message : null;

  return { expoStatus, artifactUrl, completedAt, errorMessage };
}
