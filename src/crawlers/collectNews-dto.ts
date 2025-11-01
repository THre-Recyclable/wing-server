// crawlers/dto/collect-news.dto.ts
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  ApiBody,
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';

export class CollectNewsDTO {
  // 필수, 반드시 하나의 메인 키워드
  @IsString()
  @IsNotEmpty()
  @ApiProperty({ example: '테슬라' })
  mainKeyword!: string;

  // 가변 개수의 서브 키워드 배열 (없어도 됨)
  // 전달 방식 예:
  //  - ?subKeywords=ev,battery,china
  //  - ?subKeywords=ev&subKeywords=battery&subKeywords=china
  @ApiProperty({
    description:
      '파라미터 반복 외에도 쉼표(,)로도 구분 가능합니다. 띄어쓰기 없습니다. 서버 측에서는 개수 제한이 없습니다.',
    example: ['BYD', '리튬', '중국', '환율'],
  })
  @IsOptional()
  @IsArray()
  @Type(() => String)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
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

  @ApiPropertyOptional({ description: '이건 무시하셔도 됩니다.', example: '5' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  display: number = 5; // 기본 5

  @ApiPropertyOptional({
    description: '네이버 검색 기준인데, 마찬가지로 무시하셔도 됩니다.',
    example: 'sim',
  })
  @IsOptional()
  @IsString()
  sort: 'sim' | 'date' = 'sim';

  @ApiPropertyOptional({
    description: '수집할 기사 수입니다. 무시하셔도 됩니다3',
    example: '5',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  need: number = 5; // 최소 수집할 기사 수
}
