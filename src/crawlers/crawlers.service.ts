import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { lastValueFrom } from 'rxjs';
import { NaverSearchDTO } from './naverSearchDTO';
import { CollectNewsDTO } from './collectNewsDTO';
import * as cheerio from 'cheerio';

type BuiltItem = {
  link: string; // n.news.naver.com/mnews/... 원본 링크
  title: string; // 제목(가능하면 깔끔하게 정제)
  originallink: string | null; // (있으면 채움; mnews 페이지에선 보통 없음)
  pubDate: string | null; // 원문 날짜 문자열(수집시 알려진 게 있으면 전달)
  description: string; // 크롤링한 본문 전체(plain text)
};

type CrawlNewsSingleResult = {
  query: string;
  need: number;
  collectedCount: number;
  totalEstimated?: number;
  items: BuiltItem[];
  done: boolean;
  nextStartHint: number | null;
};

type CrawlNewsByKeywordsResult = {
  mainKeyword: string;
  subKeywords: string[];
  queryCount: number;
  results: CrawlNewsSingleResult[];
};

// 줄바꿈/공백 정리
function cleanText(s: string): string {
  return s
    .replace(/\u00a0/g, ' ') // &nbsp; -> space
    .replace(/[ \t]+\n/g, '\n') // 줄 끝 공백 제거
    .replace(/\n{3,}/g, '\n\n') // 3줄 이상 연속 개행 -> 2줄
    .trim();
}

@Injectable()
export class CrawlersService {
  private readonly baseUrl = 'https://openapi.naver.com/v1/search';

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async searchNews(params: NaverSearchDTO) {
    const clientId = this.config.get<string>('NAVER_CLIENT_ID');
    const clientSecret = this.config.get<string>('NAVER_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      throw new InternalServerErrorException(
        'NAVER API 자격 증명이 설정되지 않았습니다.',
      );
    }

    try {
      const res$ = this.http.get(`${this.baseUrl}/news.json`, {
        headers: {
          'X-Naver-Client-Id': clientId,
          'X-Naver-Client-Secret': clientSecret,
        },
        // 네이버는 querystring 인코딩을 스스로 처리하지만, 안전하게 Nest/axios의 params 사용
        params,
      });
      const { data } = await lastValueFrom(res$);
      return data; // 네이버 응답(JSON) 그대로 반환
    } catch (e) {
      const err = e as AxiosError<any>;
      // 상태코드별로 의미 있는 에러로 변환
      if (err.response) {
        const status = err.response.status;
        if (status === 401 || status === 403) {
          throw new UnauthorizedException(
            'NAVER API 인증 실패(키/시크릿 확인).',
          );
        }
        if (status === 400) {
          throw new BadRequestException('NAVER API 요청 파라미터 오류.');
        }
        // 그 외 상태코드
        throw new InternalServerErrorException(`NAVER API 오류: ${status}`);
      }
      // 네트워크/타임아웃 등
      throw new InternalServerErrorException(
        'NAVER API 호출 중 네트워크 오류가 발생했습니다.',
      );
    }
  }

  async collectNaverMnewsLinks(queryInput: string) {
    const query = queryInput,
      display = 5,
      sort = 'sim',
      need = 5;

    const targetPrefix = 'https://n.news.naver.com/mnews/';
    const collected: Array<{ link: string; title: string; pubDate: string }> =
      [];
    const seen = new Set<string>(); // 링크 중복 방지

    let start = 1;
    let total = Infinity; // 첫 호출 후 total 세팅
    const maxStart = 10; // 네이버 API start 상한

    while (collected.length < need && start <= maxStart && start <= total) {
      const page = await this.searchNews({
        query,
        display,
        start,
        sort,
      });

      total = page.total ?? total; // total이 내려오면 갱신

      // 방어: 아이템 없으면 종료
      if (!page.items || page.items.length === 0) break;

      for (const it of page.items) {
        const link = it.link?.trim() ?? '';
        if (!link.startsWith(targetPrefix)) continue;
        if (seen.has(link)) continue;

        seen.add(link);
        collected.push({
          link,
          // 네이버 응답의 title은 HTML 태그가 섞일 수 있음. 저장시 제거하고 싶다면 아래 주석 해제.
          // title: it.title.replace(/<[^>]+>/g, ''),
          title: it.title,
          pubDate: it.pubDate,
        });

        if (collected.length >= need) break;
      }

      // 다음 페이지로
      start += display;

      // 안전장치: 무한루프 방지 (display가 0이거나 비정상일 때)
      if (display <= 0) break;
    }

    // 저장 훅(여기서 DB 저장 연결)
    // await this.saveCollectedLinks(collected);

    return {
      query,
      need,
      collectedCount: collected.length,
      totalEstimated: total === Infinity ? undefined : total,
      items: collected,
      done:
        collected.length >= need ||
        start > maxStart ||
        (total !== Infinity && start > total),
      nextStartHint:
        collected.length >= need
          ? null
          : start <= maxStart && (total === Infinity || start <= total)
            ? start
            : null,
    };
  }

  private async fetchHtmlDesktop(url: string): Promise<string> {
    const res$ = this.http.get(url, {
      headers: {
        // 데스크톱 UA를 명시적으로 보냄
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept-Language': 'ko,en;q=0.8',
      },
      timeout: 12_000,
      maxRedirects: 5,
      // 네이버는 gzip/deflate 기본 지원
    });
    const { data } = await lastValueFrom(res$);
    if (typeof data !== 'string') {
      throw new InternalServerErrorException('HTML 응답이 올바르지 않습니다.');
    }
    return data;
  }

  private parseBodyDesktop($: cheerio.CheerioAPI): string {
    // 1순위
    let $body = $('#dic_area');
    // 보조 컨테이너
    if ($body.length === 0) $body = $('#newsct_article');
    if ($body.length === 0)
      $body = $('#articleBody, #articeBody, .newsct_article, .article_body');

    if ($body.length === 0) return '';

    // 방해 요소 제거
    $body
      .find('script, style, noscript, iframe, figure, .ad, .promotion')
      .remove();
    $body.find('.end_photo_org, .byline, .source, .copyright').remove();

    // 줄바꿈 보존
    $body.find('br').replaceWith('\n');

    const text = $body.text();
    return cleanText(text);
  }

  /**
   * 단일 mnews 링크 → 본문만 크롤링해서 description에 채워 반환
   * title/pubDate는 seed(수집 값)를 그대로 사용
   */
  public async buildItemWithBodyFromDesktop(seed: {
    link: string;
    title: string;
    pubDate?: string;
    originallink?: string | null;
  }): Promise<BuiltItem> {
    const { link, title } = seed;
    if (!link || !link.startsWith('https://n.news.naver.com/mnews/')) {
      throw new BadRequestException('mnews 기사 링크만 지원합니다.');
    }
    if (!title) {
      throw new BadRequestException('title은 수집된 값을 사용해야 합니다.');
    }

    const html = await this.fetchHtmlDesktop(link);
    const $ = cheerio.load(html);
    const body = this.parseBodyDesktop($);

    if (!body) {
      throw new InternalServerErrorException(
        '기사 본문을 파싱하지 못했습니다.',
      );
    }

    // pubDate는 수집 값 우선. 없으면(드문 케이스) 메타에서 보강 시도 가능.
    let pubDate: string | null = seed.pubDate ?? null;
    if (!pubDate) {
      const metaIso = $('meta[property="article:published_time"]').attr(
        'content',
      );
      if (metaIso && metaIso.trim()) pubDate = metaIso.trim();
    }

    return {
      link,
      title, // ⬅️ 그대로 사용
      pubDate,
      originallink: seed.originallink ?? null,
      description: body, // ⬅️ 크롤링 결과
    };
  }

  /**
   * 여러 링크 일괄 본문 크롤링 (수집된 title을 그대로 사용)
   */
  public async enrichCollectedWithBodies(
    items: Array<{
      link: string;
      title: string;
      pubDate?: string;
      originallink?: string | null;
    }>,
  ): Promise<BuiltItem[]> {
    const tasks = items.map((it) => this.buildItemWithBodyFromDesktop(it));
    return Promise.all(tasks);
  }

  // crawlers.service.ts 내부 어딘가(프라이빗 유틸)
  private normalizeSubKeywords(input?: string | string[]): string[] {
    if (input == null) return [];
    const arr = Array.isArray(input) ? input : String(input).split(',');
    return arr.map((v) => String(v).trim()).filter(Boolean);
  }

  // 기존: (subKeywords?: string[]) -> .map()에서 크래시
  private buildQueriesFromKeywords(
    mainKeyword: string,
    subKeywords?: string | string[], // ← 시그니처 완화
  ): string[] {
    const main = String(mainKeyword ?? '').trim();
    const subs = this.normalizeSubKeywords(subKeywords); // ← 정규화
    if (subs.length === 0) return [main];
    return subs.map((s) => `${main} ${s}`);
  }

  public async crawlNewsByKeywords(
    dto: CollectNewsDTO,
  ): Promise<CrawlNewsByKeywordsResult> {
    const subs = this.normalizeSubKeywords((dto as any).subKeywords); // ← 안전 정규화
    const queries = this.buildQueriesFromKeywords(dto.mainKeyword, subs);

    const results: CrawlNewsSingleResult[] = [];
    for (const q of queries) {
      const res = await this.crawlNews(q);
      const items = (res.items ?? []) as BuiltItem[];
      results.push({
        query: q,
        need: res.need,
        collectedCount: items.length,
        totalEstimated: res.totalEstimated,
        items,
        done: res.done,
        nextStartHint: res.nextStartHint ?? null,
      });
    }

    return {
      mainKeyword: dto.mainKeyword,
      subKeywords: subs, // ← 정규화된 배열을 그대로 반환
      queryCount: queries.length,
      results,
    };
  }

  public async crawlNews(query: string) {
    const collected = await this.collectNaverMnewsLinks(query);
    const enriched = await this.enrichCollectedWithBodies(collected.items);
    return {
      ...collected,
      items: enriched,
    };
  }
}
