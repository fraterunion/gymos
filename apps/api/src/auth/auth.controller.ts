import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { extractRequestClientMeta } from '../waiver/request-client-meta';
import { AuthThrottlerGuard } from './guards/auth-throttler.guard';
import { AuthService, PASSWORD_RESET_REQUESTED_MESSAGE } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

/** Shown after a successful reset; carries no account detail. */
export const PASSWORD_RESET_COMPLETED_MESSAGE =
  'Tu contraseña fue actualizada. Ya puedes iniciar sesión.';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    const meta = extractRequestClientMeta(req);
    return this.authService.register(dto, meta);
  }

  @Post('login')
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('refresh')
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() dto: RefreshTokenDto): Promise<void> {
    await this.authService.logout(dto);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async logoutAll(@CurrentUser('sub') userId: string): Promise<void> {
    await this.authService.logoutAll(userId);
  }

  /**
   * Always 200 with the same body, whether or not the address belongs to an account —
   * this endpoint must never become a user-enumeration oracle. Throttled per IP; the
   * service additionally caps requests per account.
   */
  @Post('forgot-password')
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @HttpCode(HttpStatus.OK)
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    const meta = extractRequestClientMeta(req);
    await this.authService.requestPasswordReset(dto, meta);
    return { message: PASSWORD_RESET_REQUESTED_MESSAGE };
  }

  @Post('reset-password')
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<{ message: string }> {
    await this.authService.resetPassword(dto);
    return { message: PASSWORD_RESET_COMPLETED_MESSAGE };
  }

  /**
   * Authenticated change. Returns a fresh session bundle: all previous refresh tokens are
   * revoked, and the caller replaces its stored tokens with the ones returned here.
   */
  @Post('change-password')
  @UseGuards(JwtAuthGuard, AuthThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  @HttpCode(HttpStatus.OK)
  changePassword(
    @CurrentUser('sub') userId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(userId, dto);
  }

  /**
   * Public capability probe so login screens can hide the recovery entry point when the
   * environment has it switched off. Carries no account information whatsoever.
   */
  @Get('capabilities')
  capabilities(): { passwordRecoveryEnabled: boolean } {
    return { passwordRecoveryEnabled: this.authService.isPasswordRecoveryEnabled() };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser('sub') userId: string) {
    return this.authService.getMe(userId);
  }
}
