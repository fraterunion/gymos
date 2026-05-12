import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** #RGB, #RRGGBB, or without leading # (normalized on write). */
const hexColorPattern = /^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;

const iosBundlePattern = /^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*)+$/;
const androidPackagePattern = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export class UpdateBrandingDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  appName?: string;

  @IsOptional()
  @IsString()
  @Matches(hexColorPattern, { message: 'brandPrimaryColor must be a hex color (#RGB or #RRGGBB)' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  brandPrimaryColor?: string;

  @IsOptional()
  @IsString()
  @Matches(hexColorPattern, { message: 'brandSecondaryColor must be a hex color (#RGB or #RRGGBB)' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  brandSecondaryColor?: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  brandLogoUrl?: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  brandIconUrl?: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  brandSplashUrl?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  supportEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  supportPhone?: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  privacyUrl?: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  termsUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(iosBundlePattern, { message: 'iosBundleId must look like a reverse-DNS bundle id' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  iosBundleId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(androidPackagePattern, { message: 'androidPackageName must look like a Java package name' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  androidPackageName?: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  appStoreUrl?: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  playStoreUrl?: string;
}
