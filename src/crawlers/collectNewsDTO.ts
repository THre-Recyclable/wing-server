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

export class CollectNewsDTO {
  // 필수, 반드시 하나의 메인 키워드
  @IsString()
  @IsNotEmpty()
  mainKeyword!: string;

  // 가변 개수의 서브 키워드 배열 (없어도 됨)
  // 전달 방식 예:
  //  - ?subKeywords=ev,battery,china
  //  - ?subKeywords=ev&subKeywords=battery&subKeywords=china
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

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  display: number = 5; // 기본 5

  @IsOptional()
  @IsString()
  sort: 'sim' | 'date' = 'sim';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  need: number = 3; // 최소 수집할 기사 수
}
