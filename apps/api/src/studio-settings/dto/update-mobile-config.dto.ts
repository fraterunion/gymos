import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

function emptyToNull(v: unknown): unknown {
  if (v === '' || v === undefined) return null;
  return v;
}

const iosBundlePattern = /^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*)+$/;
const androidPackagePattern = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const schemePattern = /^[a-z][a-z0-9+.-]*$/i;

export class UpdateMobileConfigDto {
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v != null)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  appDisplayName?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v != null)
  @IsString()
  @MaxLength(64)
  @Matches(schemePattern, { message: 'appScheme must be a valid URL scheme segment' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  appScheme?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v != null)
  @IsString()
  @MaxLength(128)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  expoSlug?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v != null)
  @IsString()
  @MaxLength(255)
  @Matches(iosBundlePattern, { message: 'iosBundleIdentifier must look like a reverse-DNS bundle id' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  iosBundleIdentifier?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v != null)
  @IsString()
  @MaxLength(255)
  @Matches(androidPackagePattern, { message: 'androidPackage must look like a Java package name' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  androidPackage?: string | null;
}
