import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUrl, Matches, MaxLength, ValidateIf } from 'class-validator';

function emptyToNull(v: unknown): unknown {
  if (v === '' || v === undefined) return null;
  return v;
}

const hexColorPattern = /^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;

export class UpdateStudioBrandingDto {
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v != null)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  logoUrl?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v != null)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  coverImageUrl?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v != null)
  @IsString()
  @Matches(hexColorPattern, { message: 'primaryColor must be a hex color (#RGB or #RRGGBB)' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  primaryColor?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v != null)
  @IsString()
  @Matches(hexColorPattern, { message: 'accentColor must be a hex color (#RGB or #RRGGBB)' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  accentColor?: string | null;
}
