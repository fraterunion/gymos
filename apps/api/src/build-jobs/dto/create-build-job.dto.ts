import { BuildJobPlatform, BuildJobProfile } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class CreateBuildJobDto {
  @IsEnum(BuildJobPlatform)
  platform!: BuildJobPlatform;

  @IsEnum(BuildJobProfile)
  profile!: BuildJobProfile;
}
