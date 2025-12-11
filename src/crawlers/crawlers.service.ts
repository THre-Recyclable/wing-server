//crawlers.service.ts
import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { lastValueFrom } from 'rxjs';
import { NaverSearchDTO } from './naverSearch-dto';
import { CollectNewsDTO } from './collectNews-dto';
import * as cheerio from 'cheerio';
import { PrismaService } from 'src/prisma.service';

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

export interface IngestSummary {
  graphId: number;
  savedNodes: number;
  savedEdges: number;
  savedNews: number;
}

export type InvestingArticleFull = {
  link: string;
  title: string;
  pubDate: string | null;
  originalLink: string | null;
  description: string;
};

type InvestingApiArticle = {
  name: string;
  content: string;
  link: string;
  date: string;
  dateTimestamp: number;
  dataID: string;
  authorName: string;
  // ...필요하면 더 추가
};

type InvestingApiResponse = {
  articles: InvestingApiArticle[];
  // score, filters 등은 당장은 무시해도 됨
};

type InvestingSearchItem = {
  title: string;
  url: string;
  summary: string;
  publishedAt: string | null; // ISO string
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
    private prisma: PrismaService,
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
      display = 100,
      sort = 'sim',
      need = 100;

    const targetPrefix = 'https://n.news.naver.com/mnews/';
    const collected: Array<{ link: string; title: string; pubDate: string }> =
      [];
    const seen = new Set<string>(); // 링크 중복 방지

    let start = 1;
    let total = Infinity; // 첫 호출 후 total 세팅
    const maxStart = 10;

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

  private async fetchHtmlDesktop(url: string, attempt = 1): Promise<string> {
    try {
      const res$ = this.http.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 ...',
          'Accept-Language': 'ko,en;q=0.8',
        },
        timeout: 10000, // 10초
        maxRedirects: 5,
      });
      const { data } = await lastValueFrom(res$);
      if (typeof data !== 'string') {
        throw new InternalServerErrorException('HTML 응답이 문자열이 아님');
      }
      return data;
    } catch (e: any) {
      if (e.code === 'ECONNABORTED' && attempt < 3) {
        console.warn(`NAVER HTML timeout, retrying... (${attempt})`, url);
        await new Promise((r) => setTimeout(r, 500 * attempt));
        return this.fetchHtmlDesktop(url, attempt + 1);
      }
      console.error('NAVER HTML fetch error >>>', {
        message: e.message,
        code: e.code,
        status: e.response?.status,
      });
      throw new InternalServerErrorException('NAVER 기사 본문 요청 실패');
    }
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
      title, // 그대로 사용
      pubDate,
      originallink: seed.originallink ?? null,
      description: body, // 크롤링 결과
    };
  }

  public async enrichCollectedWithBodies(
    items: Array<{
      link: string;
      title: string;
      pubDate?: string;
      originallink?: string | null;
    }>,
    useCache = true,
  ): Promise<BuiltItem[]> {
    // 0) 링크 정규화
    const normalized = items
      .map((it) => ({
        ...it,
        link: (it.link ?? '').trim(),
      }))
      .filter((it) => it.link);

    if (normalized.length === 0) return [];

    // 캐시를 전혀 쓰지 않는 모드면, 그냥 전체를 한 번에 크롤링하되
    // 동시성 제한 + 개별 실패 스킵 로직만 적용
    if (!useCache) {
      console.log(
        `[NEWS CACHE] useCache=false, total=${normalized.length} (no cache lookup)`,
      );

      const fetched = await this.fetchBodiesWithConcurrency(normalized);
      // 원래 순서 유지
      const byLink = new Map(fetched.map((b) => [b.link, b]));
      return normalized
        .map((seed) => byLink.get(seed.link))
        .filter((b): b is BuiltItem => !!b);
    }

    // ===== 여기부터는 캐시 사용하는 모드 =====

    const links = normalized.map((it) => it.link);

    // 1) DB에서 캐시된 본문 조회
    const cachedRows = await this.prisma.newsBodyCache.findMany({
      where: {
        link: { in: links },
      },
    });

    const cacheMap = new Map(cachedRows.map((row) => [row.link, row]));

    const needFetch: typeof normalized = [];
    const builtFromCache: BuiltItem[] = [];

    // 2) 캐시 있는 건 그대로 사용, 없는 건 later fetch 목록에 넣기
    for (const seed of normalized) {
      const cached = cacheMap.get(seed.link);
      if (cached) {
        builtFromCache.push({
          link: seed.link,
          title: seed.title,
          originallink: seed.originallink ?? null,
          pubDate: seed.pubDate ?? (cached as any).pubDate ?? null,
          description: (cached as any).description,
        });
      } else {
        needFetch.push(seed);
      }
    }

    // 🔎 여기서 캐시 히트율 로깅
    {
      const total = normalized.length;
      const hit = builtFromCache.length;
      const miss = needFetch.length;
      const hitRate = total > 0 ? hit / total : 0;

      console.log(
        `[NEWS CACHE] useCache=true total=${total}, hit=${hit}, miss=${miss}, hitRate=${(
          hitRate * 100
        ).toFixed(1)}%`,
      );
    }

    // 3) 캐시 없는 기사들만 실제로 크롤링 (동시성 제한 + 실패 스킵)
    let fetched: BuiltItem[] = [];
    if (needFetch.length > 0) {
      fetched = await this.fetchBodiesWithConcurrency(needFetch);

      // 4) 새로 크롤링한 본문은 캐시에 저장
      if (fetched.length > 0) {
        await this.prisma.newsBodyCache.createMany({
          data: fetched.map((b) => ({
            link: b.link,
            title: b.title,
            description: b.description,
            pubDate: b.pubDate as any, // 스키마 타입에 맞게 필요시 new Date(...) 로 변환
          })),
          skipDuplicates: true, // 중복으로 실패하지 않게
        });
      }
    }

    const all = [...builtFromCache, ...fetched];

    // 5) 결과를 원래 items 순서에 맞게 정렬해서 반환
    const byLink = new Map(all.map((b) => [b.link, b]));
    return normalized
      .map((seed) => byLink.get(seed.link))
      .filter((b): b is BuiltItem => !!b);
  }

  /**
   * 네이버 기사 본문을 가져올 때,
   * - 동시 요청 수를 제한하고
   * - 개별 실패는 스킵하는 헬퍼
   */
  private async fetchBodiesWithConcurrency(
    seeds: Array<{
      link: string;
      title: string;
      pubDate?: string;
      originallink?: string | null;
    }>,
  ): Promise<BuiltItem[]> {
    const results: BuiltItem[] = [];

    // 프로덕션에서는 동시성 낮게, 로컬에서는 좀 더 높게
    const CONCURRENCY = process.env.NODE_ENV === 'production' ? 12 : 16;

    let i = 0;
    while (i < seeds.length) {
      const batch = seeds.slice(i, i + CONCURRENCY);

      const batchResults = await Promise.all(
        batch.map(async (seed) => {
          try {
            return await this.buildItemWithBodyFromDesktop(seed);
          } catch (e: any) {
            console.warn(
              'NAVER article body fetch failed (skip):',
              seed.link,
              e?.message ?? e,
            );
            return null;
          }
        }),
      );

      results.push(...batchResults.filter((b): b is BuiltItem => b !== null));

      i += CONCURRENCY;
    }

    return results;
  }

  private normalizeSubKeywords(input?: string | string[]): string[] {
    if (input == null) return [];
    const arr = Array.isArray(input) ? input : String(input).split(',');
    return arr.map((v) => String(v).trim()).filter(Boolean);
  }

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
    useCache = true,
  ): Promise<CrawlNewsByKeywordsResult> {
    const subs = this.normalizeSubKeywords((dto as any).subKeywords);
    const queries = this.buildQueriesFromKeywords(dto.mainKeyword, subs);

    const results: CrawlNewsSingleResult[] = [];
    for (const q of queries) {
      const res = await this.crawlNews(q, useCache);
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
      subKeywords: subs,
      queryCount: queries.length,
      results,
    };
  }

  public async crawlNews(query: string, useCache = true) {
    console.time('naver-crawl');
    const collected = await this.collectNaverMnewsLinks(query);
    console.timeEnd('naver-crawl');

    console.time('parsing time');
    const enriched = await this.enrichCollectedWithBodies(
      collected.items,
      useCache,
    );
    console.timeEnd('parsing time');

    return {
      ...collected,
      items: enriched,
    };
  }

  // ========== investing.com 본문 크롤링 로직 ==========

  private parseInvestingBody(html: string): string {
    const $ = cheerio.load(html);

    // 1) 본문 컨테이너 선택
    const $article = $('#article');
    if ($article.length === 0) return '';

    // 2) 그 안의 p 태그들을 순서대로 모아서
    const paragraphs = $article
      .find('p')
      .map((_, el) =>
        $(el)
          .text() // strong, span 등 다 포함해서 텍스트만
          .replace(/\s+/g, ' ') // 여러 공백/줄바꿈 → 한 칸
          .trim(),
      )
      .get()
      .filter(Boolean); // 빈 문단 제거

    // 3) 문단 사이에 빈 줄 넣어서 하나의 string으로 합치기
    return paragraphs.join('\n\n');
  }

  public parseInvestingArticle(
    html: string,
    url: string,
  ): InvestingArticleFull {
    const $ = cheerio.load(html);

    // 1) 제목
    const title = $('#articleTitle').text().trim();

    // 2) 출판일: "Published" 포함한 span 찾기
    const span = $('span')
      .filter((_, el) => $(el).text().includes('Published'))
      .first();

    let publishedAt: string | null = null;
    if (span.length) {
      const full = span.text().replace(/\s+/g, ' ').trim();
      // "12/01/2025, 12:31 AM" 부분만 정규식으로 추출
      const m = full.match(/\d{2}\/\d{2}\/\d{4},\s*\d{1,2}:\d{2}\s*(AM|PM)/);
      publishedAt = m ? m[0] : full.replace(/Published/i, '').trim();
    }

    // 3) 본문
    const body = this.parseInvestingBody(html); // 위에서 만든 함수 재사용

    return {
      link: url,
      title,
      pubDate: publishedAt,
      originalLink: null,
      description: body,
    };
  }

  private async fetchInvestingHtml(url: string): Promise<string> {
    const res$ = this.http.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 12_000,
      maxRedirects: 5,
    });
    const { data } = await lastValueFrom(res$);
    if (typeof data !== 'string')
      throw new InternalServerErrorException('HTML 응답이 문자열이 아님');
    return data;
  }

  public async crawlInvestingArticle(
    url: string,
  ): Promise<InvestingArticleFull> {
    const html = await this.fetchInvestingHtml(url);
    return this.parseInvestingArticle(html, url);
  }

  // ========== investing.com 기사 링크 수집 로직 ==========

  private readonly investingBaseUrl = 'https://www.investing.com';

  private async fetchInvestingAnalysisJson(
    keyword: string,
  ): Promise<InvestingApiResponse> {
    const q = keyword.trim();
    if (!q) throw new BadRequestException('검색어가 필요합니다.');

    const url = 'https://www.investing.com/search/service/SearchInnerPage';
    // ↑ 실제 발견한 엔드포인트로 교체

    const res$ = this.http.post(
      url,
      {
        searchText: q,
        type: 'analysis', // 실제 payload 키에 맞게 수정
        // page, size, filters ... 등 Network에서 확인한 파라미터 추가
      },
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest', // 필요하면
        },
        timeout: 12_000,
      },
    );

    const { data } = await lastValueFrom(res$);
    return data as InvestingApiResponse;
  }

  private mapInvestingArticles(
    data: InvestingApiResponse,
    limit = 20,
  ): InvestingSearchItem[] {
    const base = this.investingBaseUrl;
    const articles = data.articles ?? [];

    return articles.slice(0, limit).map((a) => {
      const url = a.link.startsWith('http') ? a.link : `${base}${a.link}`;
      const summary = (a.content ?? '').replace(/\s+/g, ' ').trim();

      const ts = Number(a.dateTimestamp);
      const publishedAt =
        Number.isFinite(ts) && ts > 0
          ? new Date(ts * 1000).toISOString()
          : null;

      return {
        title: a.name.trim(),
        url,
        summary,
        publishedAt,
      };
    });
  }

  public async collectInvestingAnalysisLinksFromApi(
    keyword: string,
    limit = 20,
  ): Promise<InvestingSearchItem[]> {
    const data = await this.fetchInvestingAnalysisJson(keyword);
    return this.mapInvestingArticles(data, limit);
  }

  /*
  private parseInvestingSearchAnalysisLinks(html: string, limit = 10) {
    const $ = cheerio.load(html);
    const results: InvestingSearchItem[] = [];

    // "Analysis" 섹션 헤더
    const header = $('h2')
      .filter((_, el) => $(el).text().trim() === 'Analysis')
      .first();

    if (!header.length) return results;

    // header 이후 ~ 다음 h2 전까지
    const block = header.nextUntil('h2');

    block.find('a[href*="/analysis/"]').each((_, el) => {
      if (results.length >= limit) return;

      const $a = $(el);
      const title = $a.text().trim();
      const href = $a.attr('href')?.trim();
      if (!title || !href) return;

      const url = href.startsWith('http')
        ? href
        : `https://www.investing.com${href}`;

      if (results.some((r) => r.url === url)) return;
      results.push({ title, url });
    });

    return results;
  }*/

  /*
  public async collectInvestingAnalysisLinks(
    keyword: string,
    limit = 10,
  ): Promise<InvestingSearchItem[]> {
    const q = keyword.trim();
    if (!q) throw new BadRequestException('검색어가 필요합니다.');

    const html = await this.fetchInvestingSearchHtml(q);
    return this.parseInvestingSearchAnalysisLinks(html, limit);
  }*/

  /*
  public async saveGraphForUser(
    dto: CollectNewsDTO,
    userID: string,
  ): Promise<IngestSummary> {
    const uid = (userID ?? '').trim();
    if (!uid) throw new BadRequestException('userID is required');

    const newsResult = await this.crawlNewsByKeywords(dto);

    const url = 'http://211.105.112.143:61300/process?mode=investment';
    const payload =
      typeof newsResult === 'string' ? newsResult : JSON.stringify(newsResult);

    const aiResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });

    if (!aiResp.ok) {
      const text = await aiResp.text().catch(() => '');
      throw new BadRequestException(
        `Remote process failed (${aiResp.status}): ${text || 'no body'}`,
      );
    }

    const res: {
      nodes?: Array<{ id: string; importance?: number }>;
      edges?: Array<{
        source: string;
        target: string;
        weight?: number;
        sentiment_score?: number;
        sentiment_label?: string;
        articles?: Array<{
          link?: string;
          title?: string;
          pubDate?: string;
          description?: string;
        }>;
      }>;
    } = (await aiResp.json()) ?? {};

    // 1) Node / Edge / News 변환
    const nodePairs = new Map<string, number>(); // name -> weight
    for (const n of res.nodes ?? []) {
      const name = (n.id ?? '').trim();
      if (!name) continue;
      nodePairs.set(name, Number(n.importance ?? 0));
    }

    type EdgeKey = string; // `${src}→${dst}`
    type EdgeVal = {
      weight: number;
      sentiment_score: number;
      sentiment_label: string;
    };

    const edgePairs = new Map<EdgeKey, EdgeVal>();
    const newsRows: {
      userID: string;
      startPoint: string;
      endPoint: string;
      pubDate: string;
      link: string;
      title: string;
      description: string;
    }[] = [];

    for (const e of res.edges ?? []) {
      const source = (e.source ?? '').trim();
      const target = (e.target ?? '').trim();
      if (!source || !target) continue;

      edgePairs.set(`${source}→${target}`, {
        weight: Number(e.weight ?? 0),
        sentiment_score: Number(e.sentiment_score ?? 0),
        sentiment_label: String(e.sentiment_label ?? 'neutral'),
      });

      for (const a of e.articles ?? []) {
        newsRows.push({
          userID: uid,
          startPoint: source,
          endPoint: target,
          pubDate: String(a.pubDate ?? ''),
          link: String(a.link ?? ''),
          title: String(a.title ?? ''),
          description: String(a.description ?? ''),
        });
      }
    }

    // 2) 트랜잭션
    await this.prisma.$transaction(async (tx) => {
      // 2-1) Node upsert
      for (const [name, weight] of nodePairs.entries()) {
        await tx.node.upsert({
          where: { userID_name: { userID: uid, name } },
          create: { userID: uid, name, weight },
          update: { weight },
        });
      }

      // 2-2) Edge upsert (감성 필드 포함)
      for (const [key, val] of edgePairs.entries()) {
        const [startPoint, endPoint] = key.split('→');
        await tx.edge.upsert({
          where: {
            userID_startPoint_endPoint: { userID: uid, startPoint, endPoint },
          },
          create: {
            userID: uid,
            startPoint,
            endPoint,
            weight: val.weight,
            sentiment_score: val.sentiment_score,
            sentiment_label: val.sentiment_label,
          },
          update: {
            weight: val.weight,
            sentiment_score: val.sentiment_score,
            sentiment_label: val.sentiment_label,
          },
        });
      }

      // 2-3) News createMany
      if (newsRows.length > 0) {
        const CHUNK = 500;
        for (let i = 0; i < newsRows.length; i += CHUNK) {
          await tx.news.createMany({ data: newsRows.slice(i, i + CHUNK) });
        }
      }
    });

    return {
      savedNodes: nodePairs.size,
      savedEdges: edgePairs.size,
      savedNews: newsRows.length,
    };
  }

  public async saveGraphForUser_mvp(
    dto: CollectNewsDTO,
    userID: string,
  ): Promise<IngestSummary> {
    const uid = (userID ?? '').trim();
    if (!uid) throw new BadRequestException('userID is required');

    // 최종 그래프 응답을 담을 변수
    let res: {
      nodes?: Array<{ id: string; importance?: number }>;
      edges?: Array<{
        source: string;
        target: string;
        weight?: number;
        // 원격 응답엔 아래 두 필드가 없다고 가정
        sentiment_score?: number;
        sentiment_label?: string;
        articles?: Array<{
          link?: string;
          title?: string;
          pubDate?: string;
          description?: string;
        }>;
      }>;
    };

    // 1) 키워드로 뉴스 수집
    const newsResult = await this.crawlNewsByKeywords(dto);

    // 2) 뉴스 결과를 Body로 원격 API에 POST  (래퍼 제거)
    const url = 'https://wing-ai-production.up.railway.app/process?mode=normal';

    // newsResult가 객체인지/이미 JSON 문자열인지에 따라 안전하게 처리
    const payload =
      typeof newsResult === 'string'
        ? newsResult // 이미 JSON 문자열이면 그대로
        : JSON.stringify(newsResult); // 객체면 직렬화

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new BadRequestException(
        `Remote process failed (${resp.status}): ${text || 'no body'}`,
      );
    }

    res = (await resp.json()) ?? {};

    // 3) Node / Edge / News 변환
    const nodePairs = new Map<string, number>(); // name -> weight
    for (const n of res.nodes ?? []) {
      const name = (n.id ?? '').trim();
      if (!name) continue;
      nodePairs.set(name, Number(n.importance ?? 0));
    }

    type EdgeKey = string; // `${src}→${dst}`
    type EdgeVal = {
      weight: number;
      sentiment_score: number;
      sentiment_label: string;
    };

    const edgePairs = new Map<EdgeKey, EdgeVal>();
    const newsRows: {
      userID: string;
      startPoint: string;
      endPoint: string;
      pubDate: string;
      link: string;
      title: string;
      description: string;
    }[] = [];

    for (const e of res.edges ?? []) {
      const source = (e.source ?? '').trim();
      const target = (e.target ?? '').trim();
      if (!source || !target) continue;

      // 요구사항: 응답에 감성 값이 없다면 기본값으로 채움
      edgePairs.set(`${source}→${target}`, {
        weight: Number(e.weight ?? 0),
        sentiment_score: Number(e.sentiment_score ?? 0), // 없으면 0
        sentiment_label: String(e.sentiment_label ?? 'neutral'), // 없으면 neutral
      });

      for (const a of e.articles ?? []) {
        newsRows.push({
          userID: uid,
          startPoint: source,
          endPoint: target,
          pubDate: String(a.pubDate ?? ''),
          link: String(a.link ?? ''),
          title: String(a.title ?? ''),
          description: String(a.description ?? ''),
        });
      }
    }

    // 4) 트랜잭션 저장
    await this.prisma.$transaction(async (tx) => {
      // 4-1) Node upsert
      for (const [name, weight] of nodePairs.entries()) {
        await tx.node.upsert({
          where: { userID_name: { userID: uid, name } },
          create: { userID: uid, name, weight },
          update: { weight },
        });
      }

      // 4-2) Edge upsert (감성 필드 포함)
      for (const [key, val] of edgePairs.entries()) {
        const [startPoint, endPoint] = key.split('→');
        await tx.edge.upsert({
          where: {
            userID_startPoint_endPoint: { userID: uid, startPoint, endPoint },
          },
          create: {
            userID: uid,
            startPoint,
            endPoint,
            weight: val.weight,
            sentiment_score: val.sentiment_score,
            sentiment_label: val.sentiment_label,
          },
          update: {
            weight: val.weight,
            sentiment_score: val.sentiment_score,
            sentiment_label: val.sentiment_label,
          },
        });
      }

      // 4-3) News createMany
      if (newsRows.length > 0) {
        const CHUNK = 500;
        for (let i = 0; i < newsRows.length; i += CHUNK) {
          await tx.news.createMany({ data: newsRows.slice(i, i + CHUNK) });
        }
      }
    });

    return {
      savedNodes: nodePairs.size,
      savedEdges: edgePairs.size,
      savedNews: newsRows.length,
    };
  }*/

  public async saveGraphForUser(
    dto: CollectNewsDTO,
    userID: string,
    useCache = true,
  ): Promise<IngestSummary> {
    const uid = (userID ?? '').trim();
    if (!uid) throw new BadRequestException('userID is required');

    // 0) 그래프 이름 정의 (mainKeyword + subKeywords)
    const mainKeyword = (dto.mainKeyword ?? '').trim();
    const subKeywords = dto.subKeywords ?? [];

    const graphName =
      mainKeyword && subKeywords.length > 0
        ? `${mainKeyword} - ${subKeywords.join(', ')}`
        : mainKeyword || 'Untitled graph';

    // 1) 그래프 레코드 생성
    const graph = await this.prisma.graph.create({
      data: {
        userID: uid,
        name: graphName,
      },
    });
    const graphId = graph.id;

    // 2) 키워드로 뉴스 크롤링
    const newsResult = await this.crawlNewsByKeywords(dto, useCache);

    // 2-1) 쿼리 문자열 기준 edge 통계 맵 생성
    // key: "엔비디아 젠슨 황" 같은 쿼리 문자열
    const edgeStats = this.buildEdgeStatsFromNewsResult(newsResult);

    // 2-2) AI 서버 호출
    const url = 'http://211.105.112.143:61300/process?mode=investment';
    const payload = JSON.stringify(newsResult);

    const aiResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });

    if (!aiResp.ok) {
      const text = await aiResp.text().catch(() => '');
      throw new BadRequestException(
        `Remote process failed (${aiResp.status}): ${text || 'no body'}`,
      );
    }

    const res: {
      nodes?: Array<{ id: string; importance?: number }>;
      edges?: Array<{
        source: string;
        target: string;
        weight?: number;
        sentiment_score?: number;
        sentiment_label?: string;
        articles?: Array<{
          link?: string;
          title?: string;
          pubDate?: string;
          description?: string;
        }>;
      }>;
    } = (await aiResp.json()) ?? {};

    // 3) Node / Edge / News 변환 -------------------------

    // 3-1) Node 변환: name -> { weight, kind }
    const nodePairs = new Map<
      string,
      { weight: number; kind: 'MAIN' | 'SUB' }
    >();

    const mainNormalized = mainKeyword;
    const subSet = new Set(subKeywords);

    for (const n of res.nodes ?? []) {
      const name = (n.id ?? '').trim();
      if (!name) continue;

      const weight = Number(n.importance ?? 0);

      let kind: 'MAIN' | 'SUB';
      if (name === mainNormalized) {
        kind = 'MAIN';
      } else if (subSet.has(name)) {
        kind = 'SUB';
      } else {
        // 메인/서브에 안 들어가는 애들은 일단 SUB로 취급 (필요하면 ENUM 더 늘려도 됨)
        kind = 'SUB';
      }

      nodePairs.set(name, { weight, kind });
    }

    // 3-2) Edge 변환
    type EdgeKey = string; // `${src}→${dst}`
    type EdgeVal = {
      weight: number;
      sentiment_score: number;
      sentiment_label: string;
      totalEstimated: number;
      collectedCount: number;
    };

    const edgePairs = new Map<EdgeKey, EdgeVal>();

    // 3-3) News 변환 (pubDate: DateTime)
    const newsRows: {
      userID: string;
      graphId: number;
      startPoint: string;
      endPoint: string;
      pubDate: Date;
      link: string;
      title: string;
      description: string;
    }[] = [];

    for (const e of res.edges ?? []) {
      const source = (e.source ?? '').trim();
      const target = (e.target ?? '').trim();
      if (!source || !target) continue;

      const weight = Number(e.weight ?? 0);
      const sentiment_score = Number(e.sentiment_score ?? 0);
      const sentiment_label = String(e.sentiment_label ?? 'neutral');

      const articles = e.articles ?? [];

      // ✨ 쿼리 문자열 키: 정방향 + 역방향 둘 다 시도
      const forwardKey = `${source} ${target}`.replace(/\s+/g, ' ');
      const reverseKey = `${target} ${source}`.replace(/\s+/g, ' ');

      const stat = edgeStats.get(forwardKey) ?? edgeStats.get(reverseKey);
      const collectedCount = stat?.collectedCount ?? articles.length ?? 0;
      const totalEstimated = stat?.totalEstimated ?? 0;

      const edgeKey = `${source}→${target}`;
      edgePairs.set(edgeKey, {
        weight,
        sentiment_score,
        sentiment_label,
        totalEstimated,
        collectedCount,
      });

      // 기사 저장
      for (const a of articles) {
        const rawPub = (a.pubDate ?? '').toString();
        const parsed =
          rawPub && !Number.isNaN(Date.parse(rawPub))
            ? new Date(rawPub)
            : new Date(); // 파싱 실패 시 현재 시각

        newsRows.push({
          userID: uid,
          graphId,
          startPoint: source,
          endPoint: target,
          pubDate: parsed,
          link: String(a.link ?? ''),
          title: String(a.title ?? ''),
          description: String(a.description ?? ''),
        });
      }
    }

    // 4) 트랜잭션: Node / Edge / News 저장 ----------------

    await this.prisma.$transaction(async (tx) => {
      // 4-1) Node upsert
      for (const [name, { weight, kind }] of nodePairs.entries()) {
        await tx.node.upsert({
          where: {
            graphId_name: {
              graphId,
              name,
            },
          },
          create: {
            userID: uid,
            graphId,
            name,
            weight,
            kind,
          },
          update: {
            weight,
            kind,
          },
        });
      }

      // 4-2) Edge upsert
      for (const [key, val] of edgePairs.entries()) {
        const [startPoint, endPoint] = key.split('→');
        await tx.edge.upsert({
          where: {
            graphId_startPoint_endPoint: {
              graphId,
              startPoint,
              endPoint,
            },
          },
          create: {
            userID: uid,
            graphId,
            startPoint,
            endPoint,
            weight: val.weight,
            sentiment_score: val.sentiment_score,
            sentiment_label: val.sentiment_label,
            totalEstimated: val.totalEstimated,
            collectedCount: val.collectedCount,
          },
          update: {
            weight: val.weight,
            sentiment_score: val.sentiment_score,
            sentiment_label: val.sentiment_label,
            totalEstimated: val.totalEstimated,
            collectedCount: val.collectedCount,
          },
        });
      }

      // 4-3) News bulk insert
      if (newsRows.length > 0) {
        const CHUNK = 500;
        for (let i = 0; i < newsRows.length; i += CHUNK) {
          await tx.news.createMany({
            data: newsRows.slice(i, i + CHUNK),
          });
        }
      }
    });

    return {
      graphId,
      savedNodes: nodePairs.size,
      savedEdges: edgePairs.size,
      savedNews: newsRows.length,
    };
  }

  public async clearUserGraph(userID: string) {
    if (typeof userID !== 'string' || userID.trim().length === 0) {
      throw new BadRequestException('유효한 userID가 필요합니다.');
    }

    const [newsDel, edgeDel, nodeDel] = await this.prisma.$transaction([
      this.prisma.news.deleteMany({ where: { userID } }),
      this.prisma.edge.deleteMany({ where: { userID } }),
      this.prisma.node.deleteMany({ where: { userID } }),
    ]);
  }

  // 쿼리 문자열 그대로를 key로 쓰는 버전
  private buildEdgeStatsFromNewsResult(
    newsResult: CrawlNewsByKeywordsResult,
  ): Map<string, { collectedCount: number; totalEstimated: number }> {
    const stats = new Map<
      string,
      { collectedCount: number; totalEstimated: number }
    >();

    for (const r of newsResult.results ?? []) {
      let q = (r.query ?? '').trim();
      if (!q) continue;

      // 공백 정규화: "엔비디아   젠슨   황" → "엔비디아 젠슨 황"
      q = q.replace(/\s+/g, ' ');

      const collectedCount = r.collectedCount ?? 0;
      const totalEstimated = r.totalEstimated ?? collectedCount;

      stats.set(q, { collectedCount, totalEstimated });
    }

    return stats;
  }

  async renameGraphForUser(userID: string, graphId: number, newName: string) {
    const uid = (userID ?? '').trim();
    if (!uid) {
      throw new BadRequestException('userID is required');
    }
    if (!graphId || graphId <= 0) {
      throw new BadRequestException('graphId is required');
    }

    const name = (newName ?? '').trim();
    if (!name) {
      throw new BadRequestException('new graph name is required');
    }

    // 이 유저의 그래프가 맞는지 확인
    const existing = await this.prisma.graph.findFirst({
      where: {
        id: graphId,
        userID: uid,
      },
    });

    if (!existing) {
      throw new NotFoundException('Graph not found for this user');
    }

    const updated = await this.prisma.graph.update({
      where: { id: graphId },
      data: { name },
    });

    return updated;
  }

  async deleteGraphForUser(userID: string, graphId: number) {
    const uid = (userID ?? '').trim();
    if (!uid) {
      throw new BadRequestException('userID is required');
    }
    if (!graphId || graphId <= 0) {
      throw new BadRequestException('graphId is required');
    }

    const existing = await this.prisma.graph.findFirst({
      where: {
        id: graphId,
        userID: uid,
      },
    });

    if (!existing) {
      throw new NotFoundException('Graph not found for this user');
    }

    // 자식들(Node/Edge/News) → Graph 순으로 지우기
    return this.prisma.$transaction(async (tx) => {
      const deletedNews = await tx.news.deleteMany({
        where: {
          userID: uid,
          graphId,
        },
      });

      const deletedEdges = await tx.edge.deleteMany({
        where: {
          userID: uid,
          graphId,
        },
      });

      const deletedNodes = await tx.node.deleteMany({
        where: {
          userID: uid,
          graphId,
        },
      });

      await tx.graph.delete({
        where: { id: graphId },
      });

      return {
        graphId,
        deletedNews: deletedNews.count,
        deletedEdges: deletedEdges.count,
        deletedNodes: deletedNodes.count,
      };
    });
  }
}
