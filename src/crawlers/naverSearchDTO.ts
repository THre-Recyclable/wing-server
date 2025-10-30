import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class NaverSearchDTO {
  @IsString()
  query!: string; // 필수

  // 아래는 선택(네이버 API 규격)
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  display?: number; // 한 번에 표시할 검색 결과 개수(기본 10, 최대 100)

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  start?: number; // 검색 시작 위치(기본 1, 최대 1000)

  @IsOptional()
  @IsString()
  // sim(유사도순, 기본), date(날짜순)
  sort?: 'sim' | 'date';
}
