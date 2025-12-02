// src/news/dto/get-news-query.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class GetNewsQueryDto {
  @ApiPropertyOptional({
    description: '한 번에 가져올 개수',
    example: 20,
    default: 20,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
  take?: number;

  @ApiPropertyOptional({
    description:
      '다음 페이지용 커서 (이전 응답의 meta.nextCursor 값을 그대로 넘김)',
    example: 1234,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  cursor?: number;
}
