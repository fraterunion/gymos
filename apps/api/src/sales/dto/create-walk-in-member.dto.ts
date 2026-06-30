import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateWalkInMemberDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  firstName!: string;

  @IsString()
  @MinLength(1)
  lastName!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsString()
  @MinLength(8)
  temporaryPassword!: string;
}
