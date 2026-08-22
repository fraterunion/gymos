import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { WalletPassService } from './wallet-pass.service';

function apiBaseUrl(req: Request): string {
  return `${req.protocol}://${req.get('host')}/api/v1`;
}

/**
 * Member-authenticated only — identity is always derived from the JWT (@CurrentUser), never
 * accepted from the client, so a member can only ever obtain their OWN pass. StudioMemberGuard
 * enforces studio isolation the same way every other studio-scoped route in this API does.
 * The one exception is the token-authenticated download GET, documented at its own route.
 */
@Controller('studios/:studioId/wallet')
export class WalletPassController {
  constructor(private readonly walletPassService: WalletPassService) {}

  @Post('credential')
  @UseGuards(JwtAuthGuard, StudioMemberGuard)
  @HttpCode(HttpStatus.OK)
  getBarcode(
    @Param('studioId') studioId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<{ barcode: string | null; isNew: boolean }> {
    return this.walletPassService.getBarcode(studioId, userId);
  }

  @Post('apple')
  @UseGuards(JwtAuthGuard, StudioMemberGuard)
  @HttpCode(HttpStatus.OK)
  async getApplePass(
    @Param('studioId') studioId: string,
    @CurrentUser('sub') userId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const pkpass = await this.walletPassService.getApplePass(studioId, userId);
    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': 'attachment; filename="pass.pkpass"',
    });
    return new StreamableFile(pkpass);
  }

  /**
   * Mints a short-lived (90s) URL the mobile app opens in an in-app browser — the actual
   * "Add to Apple Wallet" handoff happens via Safari's own content-type sniffing on the GET
   * below, not this endpoint. See WalletPassService.createAppleDownloadUrl for why a
   * Bearer-authenticated POST can't itself be that URL.
   */
  @Post('apple/download-link')
  @UseGuards(JwtAuthGuard, StudioMemberGuard)
  @HttpCode(HttpStatus.OK)
  async createAppleDownloadLink(
    @Param('studioId') studioId: string,
    @CurrentUser('sub') userId: string,
    @Req() req: Request,
  ): Promise<{ downloadUrl: string; expiresInSeconds: number }> {
    const downloadUrl = await this.walletPassService.createAppleDownloadUrl(studioId, userId, apiBaseUrl(req));
    return { downloadUrl, expiresInSeconds: 90 };
  }

  /**
   * Deliberately unauthenticated by JWT — the token in the path IS the authorization, exactly
   * like the pattern already established for booking-QR check-in tokens (a different secret,
   * a different purpose, same class of primitive). Safari/SFSafariViewController needs a
   * plain GET it can fetch and content-sniff on its own; it cannot attach an Authorization
   * header. Studio isolation is still enforced — the token's own studioId must match the URL.
   */
  @Get('apple/download/:token')
  async downloadApplePass(
    @Param('studioId') studioId: string,
    @Param('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const pkpass = await this.walletPassService.resolveAppleDownloadToken(studioId, token);
    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': 'attachment; filename="pass.pkpass"',
    });
    return new StreamableFile(pkpass);
  }

  @Post('google')
  @UseGuards(JwtAuthGuard, StudioMemberGuard)
  @HttpCode(HttpStatus.OK)
  getGooglePass(
    @Param('studioId') studioId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<{ saveUrl: string }> {
    return this.walletPassService.getGooglePass(studioId, userId);
  }

  /**
   * Explicit member self-service security reset (Phase 3.2) — deliberately the ONLY way to
   * reissue today. `userId` always comes from the JWT via @CurrentUser, never from client
   * input, so a member can only ever reset their OWN credential; StudioMemberGuard enforces
   * "for their current studio" the same as every other route here. No staff/admin route
   * exists yet — see Phase 3.2 report for why that was evaluated and deliberately deferred
   * rather than built speculatively.
   */
  @Post('reissue')
  @UseGuards(JwtAuthGuard, StudioMemberGuard)
  @HttpCode(HttpStatus.OK)
  reissue(
    @Param('studioId') studioId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<{ barcode: string; applePkpassAvailable: boolean; googleWalletAvailable: boolean }> {
    return this.walletPassService.reissueAndProvision(studioId, userId);
  }
}
