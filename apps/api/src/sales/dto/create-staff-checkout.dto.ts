import { IsString } from 'class-validator';

export class CreateStaffCheckoutDto {
  @IsString()
  planId!: string;
}
