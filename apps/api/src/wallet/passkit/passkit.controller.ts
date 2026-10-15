import {
  Body,
  CanActivate,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { PublicThrottlerGuard } from '../../public-discovery/public-throttler.guard';
import { passkitRoutesEnabled, WALLET_PASSKIT_ROUTE_BASE } from '../dynamic/wallet-dynamic-pass.config';
import { PasskitService } from './passkit.service';

/** WALLET_PASSKIT_ROUTES_ENABLED off (the default): every PassKit route is a plain 404. */
@Injectable()
export class PasskitRoutesEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    if (!passkitRoutesEnabled(this.config)) {
      throw new NotFoundException();
    }
    return true;
  }
}

/**
 * Apple PassKit web service endpoints, relative to a pass's webServiceURL
 * (https://<api-host>/api/v1/wallet/passkit). Paths, methods and status codes follow Apple's
 * "Adding a Web Service to Update Passes" exactly. Responses are written directly so the
 * status codes Wallet depends on (201 vs 200, 204) are never rewritten by framework defaults.
 *
 * Bodies are parsed by hand rather than through a DTO: the global ValidationPipe rejects
 * unknown fields, and a field Apple adds in the future must not break registration.
 */
@Controller(WALLET_PASSKIT_ROUTE_BASE)
@UseGuards(PasskitRoutesEnabledGuard, PublicThrottlerGuard)
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class PasskitController {
  constructor(private readonly passkit: PasskitService) {}

  @Post('v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber')
  async register(
    @Param('deviceLibraryIdentifier') deviceLibraryIdentifier: string,
    @Param('passTypeIdentifier') passTypeIdentifier: string,
    @Param('serialNumber') serialNumber: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const outcome = await this.passkit.register(
      deviceLibraryIdentifier,
      { passTypeIdentifier, serialNumber },
      authorization,
      body,
    );
    res.status(outcome === 'created' ? HttpStatus.CREATED : HttpStatus.OK).end();
  }

  @Get('v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier')
  async listUpdatedSerials(
    @Param('deviceLibraryIdentifier') deviceLibraryIdentifier: string,
    @Param('passTypeIdentifier') passTypeIdentifier: string,
    @Query('passesUpdatedSince') passesUpdatedSince: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.passkit.listUpdatedSerials(
      { deviceLibraryIdentifier, passTypeIdentifier },
      passesUpdatedSince,
    );
    if (!result) {
      res.status(HttpStatus.NO_CONTENT).end();
      return;
    }
    res.status(HttpStatus.OK).json(result);
  }

  @Delete('v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber')
  async unregister(
    @Param('deviceLibraryIdentifier') deviceLibraryIdentifier: string,
    @Param('passTypeIdentifier') passTypeIdentifier: string,
    @Param('serialNumber') serialNumber: string,
    @Headers('authorization') authorization: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    await this.passkit.unregister(deviceLibraryIdentifier, { passTypeIdentifier, serialNumber }, authorization);
    res.status(HttpStatus.OK).end();
  }

  /**
   * 200 with the .pkpass, or an explicit 304 when the device's If-Modified-Since shows it is
   * current. The body is written with res.end(), not res.send(), so Express's implicit
   * ETag/freshness handling cannot turn a logged "served" into an unlogged 304.
   */
  @Get('v1/passes/:passTypeIdentifier/:serialNumber')
  async getLatestPass(
    @Param('passTypeIdentifier') passTypeIdentifier: string,
    @Param('serialNumber') serialNumber: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('if-modified-since') ifModifiedSince: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.passkit.getLatestPass({ passTypeIdentifier, serialNumber }, authorization, ifModifiedSince);
    const headers = { 'Last-Modified': result.lastModifiedAt.toUTCString(), 'Cache-Control': 'no-store' };
    if (result.notModified) {
      res.status(HttpStatus.NOT_MODIFIED).set(headers).end();
      return;
    }
    res
      .status(HttpStatus.OK)
      .set({ ...headers, 'Content-Type': 'application/vnd.apple.pkpass', 'Content-Length': String(result.pkpass.length) })
      .end(result.pkpass);
  }

  @Post('v1/log')
  @HttpCode(HttpStatus.OK)
  log(@Body() body: unknown): void {
    this.passkit.recordDeviceLog(body);
  }
}
