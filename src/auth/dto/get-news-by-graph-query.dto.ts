// src/auth/dto/get-news-by-graph-query.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';
import { GetNewsQueryDto } from './get-news-query.dto';

export class GetNewsByGraphQueryDto extends GetNewsQueryDto {
  @ApiProperty({
    description: '조회할 그래프 ID',
    example: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  graphId: number;
}
