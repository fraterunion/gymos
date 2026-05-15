import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PlatformOperatorService {
  private readonly domain: string;
  private readonly extras: ReadonlySet<string>;

  constructor(configService: ConfigService) {
    const rawDomain = configService.get<string>('PLATFORM_OPERATOR_EMAIL_DOMAIN') ?? 'fraterunion.co';
    this.domain = rawDomain.trim().toLowerCase().replace(/^@/, '');
    const rawExtras = configService.get<string>('PLATFORM_EXTRA_OPERATOR_EMAILS') ?? '';
    this.extras = new Set(
      rawExtras
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
  }

  /** FraterUnion / internal tooling — matches admin gate. */
  isOperator(email: string | undefined | null): boolean {
    if (!email || typeof email !== 'string') return false;
    const e = email.trim().toLowerCase();
    if (e.endsWith(`@${this.domain}`)) return true;
    return this.extras.has(e);
  }
}
