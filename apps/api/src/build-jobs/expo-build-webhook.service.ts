import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { webhookPayloadToRemoteStatus } from './expo-build-status';
import {
  expoWebhookDeliveryKey,
  tryClaimExpoWebhookDelivery,
} from './expo-build-webhook-idempotency';
import {
  isExpoBuildWebhookPayload,
  parseExpoBuildWebhookPayload,
} from './expo-build-webhook-payloads';
import { verifyExpoWebhookSignature } from './expo-build-webhook-signature';
import { BuildJobsService } from './build-jobs.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ExpoBuildWebhookService {
  private readonly logger = new Logger(ExpoBuildWebhookService.name);
  private warnedMissingSecret = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly buildJobs: BuildJobsService,
  ) {}

  async handleIncomingWebhook(
    rawBody: Buffer,
    expoSignature: string | undefined,
  ): Promise<{ received: true; updated: boolean }> {
    this.assertWebhookAuthConfigured(rawBody, expoSignature);

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      this.logger.warn(JSON.stringify({ event: 'expo_webhook_ignored', reason: 'invalid_json' }));
      return { received: true, updated: false };
    }

    const payload = parseExpoBuildWebhookPayload(parsed);
    if (!payload) {
      this.logger.warn(JSON.stringify({ event: 'expo_webhook_ignored', reason: 'invalid_payload' }));
      return { received: true, updated: false };
    }

    if (!isExpoBuildWebhookPayload(payload)) {
      this.logger.log(
        JSON.stringify({
          event: 'expo_webhook_ignored',
          reason: 'not_build_event',
          expoBuildId: payload.id,
        }),
      );
      return { received: true, updated: false };
    }

    const deliveryKey = expoWebhookDeliveryKey(rawBody);
    const claimed = await tryClaimExpoWebhookDelivery(this.prisma, {
      deliveryKey,
      expoBuildId: payload.id,
    });
    if (!claimed) {
      this.logger.log(
        JSON.stringify({
          event: 'expo_webhook_duplicate',
          expoBuildId: payload.id,
        }),
      );
      return { received: true, updated: false };
    }

    const job = await this.buildJobs.findByExpoBuildId(payload.id);
    if (!job) {
      this.logger.log(
        JSON.stringify({
          event: 'expo_webhook_no_job',
          expoBuildId: payload.id,
          status: payload.status,
        }),
      );
      return { received: true, updated: false };
    }

    const remote = webhookPayloadToRemoteStatus(payload);
    await this.buildJobs.syncEasBuildStatus(job.id, remote);

    this.logger.log(
      JSON.stringify({
        event: 'expo_webhook_applied',
        jobId: job.id,
        expoBuildId: payload.id,
        expoStatus: remote.expoStatus,
        studioId: job.studioId,
      }),
    );

    return { received: true, updated: true };
  }

  private assertWebhookAuthConfigured(rawBody: Buffer, expoSignature: string | undefined): void {
    const secret = this.config.get<string>('EXPO_BUILD_WEBHOOK_SECRET')?.trim() ?? '';
    const nodeEnv = this.config.get<string>('NODE_ENV', 'development');

    if (!secret) {
      if (nodeEnv === 'production') {
        throw new ForbiddenException('Expo build webhook secret is not configured');
      }
      if (!this.warnedMissingSecret) {
        this.warnedMissingSecret = true;
        this.logger.warn(
          JSON.stringify({
            event: 'expo_webhook_secret_missing',
            message:
              'EXPO_BUILD_WEBHOOK_SECRET is unset; accepting unsigned webhooks in non-production only',
          }),
        );
      }
      return;
    }

    if (!expoSignature) {
      throw new UnauthorizedException('Missing expo-signature header');
    }
    if (!verifyExpoWebhookSignature(rawBody, expoSignature, secret)) {
      throw new UnauthorizedException('Invalid expo-signature');
    }
  }
}
