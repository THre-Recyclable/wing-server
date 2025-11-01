import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class RegisterUserDTO {
  @ApiProperty()
  @IsString()
  id: string;

  @ApiProperty()
  @IsString()
  password: string;
}
