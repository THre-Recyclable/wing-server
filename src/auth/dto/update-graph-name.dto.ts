// src/crawlers/dto/update-graph-name.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class UpdateGraphNameDto {
  @ApiProperty({
    description: '새 그래프 이름',
    example: '엔비디아 - 젠슨 황, TSMC, HBM',
  })
  @IsString()
  @IsNotEmpty()
  name: string;
}
