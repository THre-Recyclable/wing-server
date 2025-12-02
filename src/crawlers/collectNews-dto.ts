// crawlers/dto/collect-news.dto.ts
import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CollectNewsDTO {
  // 필수, 반드시 하나의 메인 키워드
  @IsString()
  @IsNotEmpty()
  @ApiProperty({ example: '테슬라' })
  mainKeyword!: string;

  // 가변 개수의 서브 키워드 배열
  @ApiPropertyOptional({
    description:
      '반복 파라미터 또는 쉼표(,) 구분 문자열 허용. 서버에서 string[]로 정규화됩니다.',
    example: ['BYD', '리튬', '중국', '환율'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => {
    // 허용 입력: undefined | string | string[]
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) {
      return value.map((v) => String(v).trim()).filter((v) => v.length > 0);
    }
    // "a,b,c" 형태 처리
    return String(value)
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  })
  subKeywords: string[] = [];
}
