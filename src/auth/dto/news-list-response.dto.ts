// src/news/dto/news-list-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';

export class NewsEntity {
  @ApiProperty({ example: 'clzh0u3o3000s1x2y3z4' })
  id: number;

  @ApiProperty({ example: 'user55' })
  userID: string;

  @ApiProperty({
    example: '서방, 기술 냉소주의에 빠져…전기 무료로 쓰는 중국과 대조적',
  })
  title: string;

  @ApiProperty({
    example: 'https://n.news.naver.com/mnews/article/001/0015726856?sid=104',
  })
  link: string;

  @ApiProperty({
    example: 'Thu, 06 Nov 2025 09:03:00 +0900',
  })
  pubDate: Date;

  @ApiProperty({
    example: `美규제 맞서 기술자립 박차 화웨이 등 첨단칩 자급자족 코로나 봉쇄때 기술 키웠듯 AI 기술력 급속성장 가능성 젠슨황 "전력 싸고 규제 유연 중국...`,
  })
  description: string;
}

export class NewsListMetaDto {
  @ApiProperty({
    description: '다음 페이지가 더 있는지 여부',
    example: true,
  })
  hasNextPage: boolean;

  @ApiProperty({
    description:
      '다음 페이지 조회용 커서. 다음 요청에서 cursor로 그대로 넘기면 됨. (없으면 null)',
    example: 1234,
    nullable: true,
  })
  nextCursor: number | null;
}

export class NewsListResponseDto {
  @ApiProperty({
    description: '뉴스 목록',
    type: NewsEntity,
    isArray: true,
  })
  items: NewsEntity[];

  @ApiProperty({
    description: '페이지네이션 메타 정보',
    type: NewsListMetaDto,
  })
  meta: NewsListMetaDto;
}
