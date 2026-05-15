import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ExpoBuildWebhookService } from './expo-build-webhook.service';

@Controller('webhooks/expo')
export class ExpoBuildWebhookController {
  constructor(private readonly expoBuildWebhook: ExpoBuildWebhookService) {}

  @Post('build')
  @HttpCode(HttpStatus.OK)
  async handleBuild(
    @Headers('expo-signature') expoSignature: string | undefined,
    @Req() req: Request,
  ): Promise<{ received: true; updated: boolean }> {
    const rawBody = this.readRawBody(req);
    return this.expoBuildWebhook.handleIncomingWebhook(rawBody, expoSignature);
  }

  private readRawBody(req: Request): Buffer {
    const raw = req.body;
    if (Buffer.isBuffer(raw)) return raw;
    if (typeof raw === 'string') return Buffer.from(raw, 'utf8');
    throw new BadRequestException('Invalid webhook body');
  }
}
