import { Role, StaffType } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class UpdateStaffDto {
  @IsOptional()
  @IsIn([Role.ADMIN, Role.STAFF, Role.FRONT_DESK])
  role?: Role;

  @IsOptional()
  @IsEnum(StaffType)
  staffType?: StaffType;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  specialties?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  photoUrl?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
