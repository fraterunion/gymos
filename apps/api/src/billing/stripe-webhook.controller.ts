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
import { StripeWebhookService } from './stripe-webhook.service';

@Controller('stripe')
export class StripeWebhookController {
  constructor(private readonly stripeWebhookService: StripeWebhookService) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handle(
    @Headers('stripe-signature') signature: string | undefined,
    @Req() req: Request,
  ): Promise<{ received: true }> {
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }
    const raw = req.body;
    let rawBody: Buffer;
    if (Buffer.isBuffer(raw)) {
      rawBody = raw;
    } else if (typeof raw === 'string') {
      rawBody = Buffer.from(raw, 'utf8');
    } else {
      throw new BadRequestException('Invalid webhook body');
    }
    await this.stripeWebhookService.handleIncomingWebhook(rawBody, signature);
    return { received: true };
  }
}
