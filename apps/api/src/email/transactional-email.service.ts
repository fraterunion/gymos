import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildResetUrl,
  resolveEmailBranding,
  selectBrandingStudio,
  type PlatformEmailDefaults,
  type ResolvedEmailBranding,
} from './email-branding';
import { EMAIL_PROVIDER, type EmailProvider } from './email-provider';
import {
  renderPasswordResetEmail,
  type EmailLocale,
} from './templates/password-reset.template';

/**
 * The application's entry point for transactional email. Callers pass domain intent
 * ("send this user a password reset"); this service resolves white-label branding, renders
 * the message and hands it to whichever provider is configured. No caller imports a vendor
 * SDK, and no template hardcodes a studio.
 */

export type SendPasswordResetInput = {
  userId: string;
  email: string;
  firstName?: string | null;
  /** Plaintext one-time token. Held only in memory and in the rendered message. */
  token: string;
  expiresInMinutes: number;
  /** Studio the request came from, honoured only if the user belongs to it. */
  hintedStudioId?: string | null;
  locale?: EmailLocale;
};

export type SendPasswordResetResult = {
  delivered: boolean;
  branding: ResolvedEmailBranding;
};

@Injectable()
export class TransactionalEmailService {
  private readonly logger = new Logger(TransactionalEmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider,
  ) {}

  /** Neutral platform identity — never a studio name. */
  platformDefaults(): PlatformEmailDefaults {
    return {
      platformName: this.config.get<string>('EMAIL_PLATFORM_NAME', 'GymOS'),
      fromEmail: this.config.get<string>('EMAIL_FROM_ADDRESS', 'no-reply@gymos.app'),
      fromName: this.config.get<string>('EMAIL_FROM_NAME', '') || null,
      supportEmail: this.config.get<string>('EMAIL_SUPPORT_ADDRESS', '') || null,
      // Never derived from CORS_ORIGIN: that list is ordered for browser origins, and its
      // first entry is a deploy-specific host — reset links must point at the canonical
      // public surface. Production boot requires this explicitly (see validateEnv); the
      // localhost default only ever applies to dev/test.
      resetUrlBase:
        this.config.get<string>('PASSWORD_RESET_URL_BASE', '').trim() || 'http://localhost:3000',
    };
  }

  /**
   * Resolves which studio brands this user's mail. Returns null for a user with no studio
   * memberships (platform-neutral branding).
   */
  async resolveBrandingForUser(
    userId: string,
    hintedStudioId?: string | null,
  ): Promise<ResolvedEmailBranding> {
    const defaults = this.platformDefaults();
    const memberships = await this.prisma.studioMembership.findMany({
      where: { userId, deletedAt: null, studio: { deletedAt: null } },
      select: { studioId: true, createdAt: true },
    });
    const studioId = selectBrandingStudio(memberships, hintedStudioId ?? null);
    if (!studioId) {
      return resolveEmailBranding(null, defaults);
    }
    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: {
        id: true,
        slug: true,
        name: true,
        appName: true,
        appDisplayName: true,
        brandPrimaryColor: true,
        primaryColor: true,
        brandLogoUrl: true,
        logoUrl: true,
        supportEmail: true,
        supportPhone: true,
      },
    });
    return resolveEmailBranding(studio, defaults);
  }

  async sendPasswordReset(input: SendPasswordResetInput): Promise<SendPasswordResetResult> {
    const branding = await this.resolveBrandingForUser(input.userId, input.hintedStudioId);
    const defaults = this.platformDefaults();
    const resetUrl = buildResetUrl(defaults.resetUrlBase, input.token, branding.studioSlug);

    const rendered = renderPasswordResetEmail({
      branding,
      resetUrl,
      expiresInMinutes: input.expiresInMinutes,
      firstName: input.firstName ?? null,
      locale: input.locale,
    });

    const result = await this.provider.send({
      to: input.email,
      from: branding.from,
      replyTo: branding.supportEmail ?? undefined,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      // Tags are provider-dashboard metadata: ids only, never the token or the address.
      tags: {
        type: 'password_reset',
        studio: branding.studioSlug ?? 'platform',
      },
    });

    // Deliberately logs no email address and no token — only correlation ids.
    this.logger.log(
      JSON.stringify({
        event: 'password_reset_email_dispatched',
        userId: input.userId,
        studioId: branding.studioId,
        provider: this.provider.name,
        delivered: result.delivered,
      }),
    );

    return { delivered: result.delivered, branding };
  }
}
