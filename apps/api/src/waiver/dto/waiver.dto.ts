import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class AcceptWaiverDto {
  @IsString()
  waiverDocumentId!: string;

  @IsBoolean()
  accepted!: boolean;
}

export class WaiverAttestationDto {
  @IsString()
  waiverDocumentId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  attestationNote?: string;
}
