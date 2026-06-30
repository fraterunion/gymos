import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateOperationalNoteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  body!: string;
}
