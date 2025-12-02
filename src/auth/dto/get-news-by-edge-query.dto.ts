// src/auth/dto/get-news-by-edge-query.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsString, Min } from 'class-validator';
import { GetNewsQueryDto } from './get-news-query.dto';

export class GetNewsByEdgeQueryDto extends GetNewsQueryDto {
  @ApiProperty({
    description: '조회할 그래프 ID',
    example: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  graphId: number;

  @ApiProperty({
    description:
      '엣지의 시작 키워드(방향성은 중요하지 않으므로, endPoint와 뒤바뀌어도 처리됨)',
    example: '엔비디아',
  })
  @IsString()
  startPoint: string;

  @ApiProperty({
    description:
      '엣지의 끝 키워드(방향성은 중요하지 않으므로, startPoint와 뒤바뀌어도 처리됨)',
    example: '젠슨 황',
  })
  @IsString()
  endPoint: string;
}
