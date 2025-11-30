// src/keywords/dto/subkeywords-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';

export class SubkeywordsResponseDto {
  @ApiProperty({
    description: '요청에 사용된 메인 키워드',
    example: '엔비디아',
  })
  mainKeyword: string;

  @ApiProperty({
    description: '추천된 서브 키워드 목록',
    example: ['젠슨황', '데이터센터', 'TSMC', 'HBM', 'AI 반도체'],
    isArray: true,
    type: String,
  })
  subKeywords: string[];
}
