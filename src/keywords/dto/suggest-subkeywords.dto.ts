// src/keywords/dto/suggest-subkeywords.dto.ts
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SuggestSubkeywordsDto {
  @ApiProperty({
    description: '메인 키워드 (뉴스/증권 기사에서 기준이 되는 키워드)',
    example: '엔비디아',
  })
  @IsString()
  @IsNotEmpty()
  mainKeyword: string;

  @ApiPropertyOptional({
    description: '추천받을 서브 키워드 개수 (1~20, 기본 8개)',
    minimum: 1,
    maximum: 20,
    example: 7,
    default: 8,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  count?: number = 8; // 기본 8개
}
