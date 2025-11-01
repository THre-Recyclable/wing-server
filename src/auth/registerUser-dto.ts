import { IsString } from 'class-validator';

export class RegisterUserDTO {
  @IsString()
  id: string;

  @IsString()
  password: string;
}
