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
  savedNodes: number;
  savedEdges: number;
  savedNews: number;
}

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

  private async dummyAgentCall(): Promise<{
    nodes: Array<{ id: string; importance: number }>;
    edges: Array<{
      source: string;
      target: string;
      weight: number;
      cooccurrence: number;
      similarity: number;
      articles: Array<{
        link: string;
        title: string;
        pubDate: string;
        trust_score: number;
        description: string;
        sentiment_description: string;
      }>;
      sentiment_score: number;
      sentiment_label: 'positive' | 'neutral' | 'negative' | string;
      sentiment_subject: string;
      sentiment_derivation: 'direct' | 'propagated' | string;
      hops_to_main?: number;
    }>;
    metadata: { total_nodes: number; total_edges: number };
  }> {
    return {
      nodes: [
        { id: 'BYD', importance: 0.889060663111203 },
        { id: '관세', importance: 1.0 },
        { id: '테슬라', importance: 0.7292983810408136 },
        { id: '중국', importance: 0.9250401273842137 },
        { id: '리튬', importance: 0.9235663595717322 },
      ],
      edges: [
        {
          source: 'BYD',
          target: '테슬라',
          weight: 0.8659379571676254,
          cooccurrence: 0.8,
          similarity: 0.9318759143352509,
          articles: [
            {
              link: 'https://n.news.naver.com/mnews/article/396/0000725571?sid=103',
              title:
                '전기차, 효율을 넘어 브랜드의 시대로…전삼사가 이끄는 새로운 소비 기...',
              pubDate: 'Wed, 29 Oct 2025 16:34:00 +0900',
              trust_score: 0.6005909172301145,
              description:
                'Polestar 4 MY 26\n  국내 전기차 시장이 새로운 전환점에 들어섰다. 과거에는 유지비 절감과 보조금이 소비자 선택의 핵심 요인이었다....',
              sentiment_description:
                '[CLS] 이 가운데 시장을 견인한 것은 테슬라 · 폴스타 · BYD 등 순수 전기차 브랜드다. [SEP]\n[CLS] 전기차 브랜드 테슬라, 폴스타, BYD는 대중화, 고급화와 브랜드 감성, 실속형이라는 각자의 정체성을 강화하며, 소비자 선택의 기준은 더욱 세분화되고 있다. [SEP]\n[CLS] [UNK], 볼륨형 모델로 시장 주도 [SEP]\n[CLS] 테슬라는 9월 한 달간 9069대를 판매하며 3개월 연속 수입차 전체 1위를 기록했다. [SEP]\n[CLS] 테슬라가 대중화 모델로 시장 볼륨을 확장했다면, 스웨덴 프리미엄 전기차 브랜드 폴스타는 브랜드 가치 중심의 성장을 이어가며 국내 전기차 시장 내 프리미엄 세그먼트를 공고히 하고 있다. [SEP]\n[CLS] 씨라이언 7은 4, 490만원대의 합리적인 가격에 중형 SUV급 차체 ( 전장 4, 830㎜ ) 를 갖춰 테슬라 모델 Y보다 약 800만원 저렴하면서도 공간성과 실용성을 강화했다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/015/0005203081?sid=101',
              title: '재팬모빌리티쇼 30일 개막…현대차·BYD, 전기차로 격돌',
              pubDate: 'Tue, 28 Oct 2025 15:56:00 +0900',
              trust_score: 0.5605756230124223,
              description:
                "'수입차의 무덤' 일본시장 공략\n\n현대차 - 수소전기차 '뉴 넥쏘' 공개\n기아 - 목적기반차량 'PV5' 데뷔\n\nBYD - 경형 전기차 세계 첫...",
              sentiment_description:
                '[CLS] 닛산 등 자국 브랜드가 자리를 지키고 있는 데다 BYD와 테슬라가 이미 일본 전기차 시장에서 두각을 나타내고 있어서다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/277/0005670297?sid=103',
              title: "BYD의 '중국식 혁신', 세계를 압박하다",
              pubDate: 'Tue, 28 Oct 2025 07:00:00 +0900',
              trust_score: 0.5605756230124223,
              description:
                "\n도요타·테슬라·BYD 등 경쟁사 분석\nBYD, 기술·생산·가격 '삼박자'로\n중국식 혁신 모델로 전기차 점유...",
              sentiment_description:
                '[CLS] 도요타 · 테슬라 · BYD 등 경쟁사 분석 [SEP]\n[CLS] 출력과 전압 모두 현대차 ( 350㎾ · 800V ) 를 넘어섰고, 테슬라가 최근 선보인 최대 500㎾ 충전이 가능한 4세대 슈퍼차저보다도 높은 성능을 구현했다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/023/0003936202?sid=101',
              title: '테슬라·미니·BYD… 중국産 전기차의 한국 공습',
              pubDate: 'Thu, 23 Oct 2025 00:34:00 +0900',
              trust_score: 0.42756262292958813,
              description:
                '올 들어 5만대 판매… 작년의 두 배\n\t\t\t\t\t\t\t올해 한국에서 팔린 전기차 3대 중 1대는 중국산이다. 22일 한국자동차모빌리티산업협회(KAM...',
              sentiment_description:
                '[CLS] 테슬라 · 미니 · BYD … 중국 産 전기차의 한국 공습 [SEP]\n[CLS] 하지만 미국 1위 전기차 업체 테슬라를 필두로 글로벌 자동차 업체들이 중국을 속속 ‘ 전기차 생산 기지 ’ 로 삼으면서, 이런 인식은 희박해지고 있다. [SEP]\n[CLS] 국내 중국산 전기차 강세는 테슬라가 주도하고 있다. [SEP]\n[CLS] 테슬라는 중국 상하이 공장에 테슬라식 생산 방식을 이식한 후, 중국을 자동차 ‘ 파운드리 ( 위탁 생산 ) ’ 기지로 활용하고 있다. [SEP]\n[CLS] 가까운 한국 · 일본 등 아시아권에 중국산 테슬라를 대거 공급하고 있는 것이다. [SEP]\n[CLS] 테슬라는 한국에 2023년부터 중국산 전기차를 들여오기 시작했다. [SEP]\n[CLS] 올 1 ~ 9월 중국산 테슬라 차량은 4만3448대 판매되며 전체 중국산 전기차 판매량의 84 % 를 차지했다. [SEP]\n[CLS] 산업통상부 관계자는 “ 테슬라라는 브랜드가 생산지에 대한 우리 소비자의 불편한 감정을 완전히 지워버린 사례 ” 라면서 “ 테슬라로 인해 중국산 차의 품질도 나쁘지 않다는 인식까지 생기고 있어 앞으로 한국차 경쟁력이 우려될 정도 ” 라고 했다. [SEP]\n[CLS] 테슬라의 성공 공식을 본 다른 글로벌 기업들도 속속 이 대열에 합류하고 있다. [SEP]',
            },
          ],
          sentiment_score: 0.7346796296452185,
          sentiment_label: 'positive',
          sentiment_subject: '테슬라',
          sentiment_derivation: 'direct',
        },
        {
          source: '중국',
          target: '테슬라',
          weight: 0.8643989503383637,
          cooccurrence: 0.8,
          similarity: 0.9287979006767273,
          articles: [
            {
              link: 'https://n.news.naver.com/mnews/article/014/0005427476?sid=101',
              title:
                '[뉴욕증시] 메타 급락세 속 3대 지수 일제히 하락…테슬라·엔비디아 동...',
              pubDate: 'Fri, 31 Oct 2025 05:52:00 +0900',
              trust_score: 0.7,
              description:
                '[파이낸셜뉴스]\n\n뉴욕 증시 3대 지수가 30일(현지시간) 일제히 하락했다.\n\n전날까지 거래일 기준으로 나흘 내리 사상 최고 행진을 이어갔던 나...',
              sentiment_description:
                '[CLS] [ 뉴욕증시 ] 메타 급락세 속 3대 지수 일제히 하락 … 테슬라 · 엔비디아 동... [SEP]\n[CLS] 테슬라 급락 [SEP]\n[CLS] 테슬라는 급락했다. [SEP]\n[CLS] 테슬라는 사이버트럭 리콜 등 악재가 겹친 가운데 미국 최대 연기금 캘퍼스 ( 캘리포니아 공무원 연기금 ) 가 일론 머스크 최고경영자 ( CEO ) 에 대한 최대 1조달러 보상 패키지에 반대한다고 선언하면서 급락했다. [SEP]\n[CLS] 캘퍼스는 보상 패키지가 과도하고, 이미 개인으로는 최대 주주인 머스크에게 테슬라 권력이 집중된다며 반대했다. [SEP]\n[CLS] 캘퍼스의 테슬라 지분율은 0. 15 % 안팎에 불과한 것으로 알려져 있지만 블랙록, 뱅가드 등 테슬라 기관 투자가들에게 막강한 영향력을 행사하기 때문에 간과할 수 없다는 우려가 나왔다. [SEP]\n[CLS] 다음 달 6일 연례 주주총회에서 머스크를 회사에 붙잡아 둘 수 있는 1조달러 보상 패키지가 부결될 수도 있다는 우려 속에 테슬라 주가는 급락했다. [SEP]\n[CLS] 테슬라는 21. 41달러 ( 4. 64 % ) 급락한 440. 10달러로 미끄러졌다. [SEP]\n[CLS] 머스크가 테슬라 최대 자산이라고 믿는 투자자들이 1조달러 보상 패키지 불발이 현실화하면 머스크가 회사를 떠날지 모른다고 우려한 탓이다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/374/0000471931?sid=104',
              title: '테슬라, 내달 상하이서 사이버캡 공개…아시아 시장 첫 데뷔',
              pubDate: 'Fri, 31 Oct 2025 04:22:00 +0900',
              trust_score: 0.7,
              description:
                "테슬라가 자율주행 전용 로보택시 모델인 사이버캡을 오는 11월 5일부터 10일까지 중국 상하이에서 열리는 '중국 국제수입 박람회' (China...",
              sentiment_description:
                "[CLS] 테슬라, 내달 상하이서 사이버캡 공개 … 아시아 시장 첫 데뷔 [SEP]\n[CLS] 테슬라가 자율주행 전용 로보택시 모델인 사이버캡을 오는 11월 5일부터 10일까지 중국 상하이에서 열리는 ' 중국 국제수입 박람회 ' ( China International Import Expo ) 에서 선보입니다. [SEP]\n[CLS] 현지시간 30일 로이터통신에 따르면 테슬라 중국법인 부사장인 린타오 ( Tao Lin ) 는 중국 소셜미디어 웨이보를 통해 “ 사이버캡이 올해 상하이 수입박람회에서 공개될 예정 ” 이라며 “ 테슬라의 혁신 기술을 중국 관람객들에게 선보이게 되어 기쁘다 ” 고 밝혔습니다. [SEP]\n[CLS] 테슬라 측은 현재로서는 “ 전시 중심의 공개 행사 ” 로 한정된다고만 언급했습니다. [SEP]\n[CLS] 사이버캡은 지난해 10월 테슬라가 처음 내놓은 로보택시 전용 차량입니다. [SEP]\n[CLS] 최근 테슬라는 사이버캡에 운전대와 페달이 있는 일반 차량 형태로 판매할 수 있는 가능성도 열어뒀습니다. [SEP]\n[CLS] 로빈 덴홀름 테슬라 이사회 의장은 블룸버그와의 인터뷰에서 “ 만약 운전대가 필요하다면 달 수 있다. [SEP]\n[CLS] 덴홀름 의장은 “ 사이버캡은 투자자들이 흔히 ‘ 모델 2 ’ 라 부르는, 모델 3보다 저가의 차량 ” 이라며 완전 자율주행 기술 상용화에 집중하던 테슬라의 제품 전략 변화를 시사했습니다. [SEP]\n[CLS] 당시 그는 “ 2만5000달러짜리 일반 전기차를 만드는 것은 무의미하다 ” 며 “ 그건 테슬라의 철학에 정면으로 반하는 일 ” 이라고 강조했지만, 이번 발언은 그러한 입장에 다소 후퇴했음을 보여줍니다. [SEP]\n[CLS] 테슬라는 2026년 대량생산을 목표로 하고 있으며, 자율주행차 관련 안전 기준을 완화하기 위해 규제 당국을 설득하고 있습니다. [SEP]\n[CLS] 투자자들 사이에서는 이번 발언을 “ 테슬라가 결국 실용 노선으로 돌아왔다 ” 는 신호로 보고 있습니다. [SEP]\n[CLS] 머스크가 강조해온 완전 자율주행 기술이 상용화되기까지는 시간이 더 걸릴 것으로 예상되며, 테슬라는 그동안 정체됐던 보급형 전기차 시장에서 성장동력을 확보하려는 것으로 풀이됩니다. [SEP]",
            },
            {
              link: 'https://n.news.naver.com/mnews/article/008/0005270487?sid=101',
              title:
                "미국은 '뇌'·중국은 '눈' 싹쓸이…손발 묶인 K-자율주행, 부품서도 밀린...",
              pubDate: 'Thu, 30 Oct 2025 08:00:00 +0900',
              trust_score: 0.6467511599000726,
              description:
                "[MT리포트] 속도 못내는 K-자율주행 (下)[편집자주] 미국과 중국은 자율주행 상용화를 가속화하며 도로 위에서 '모빌리티 산업의 미래'를 실현...",
              sentiment_description:
                '[CLS] 테슬라 등 일부가 시장 초기 비싼 라이다 가격 때문에 라이다 없이 자율주행하는 기술에 도전했지만 최근엔 라이다 가격이 낮아지면서 배제할 이유가 없다는 게 업계의 중론이다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/018/0006148192?sid=101',
              title:
                '서학개미, 테슬라 대신 SPY 샀다…3분기 외화증권 보관액 2203억달러',
              pubDate: 'Mon, 27 Oct 2025 10:42:00 +0900',
              trust_score: 0.5258872488031037,
              description:
                '예탁원 “3분기 외화증권 보관액 전년비 60% 증가”\n전분기와 비교해도 19% 늘어…보관액 1위는 테슬라\n외화증권 결제액 15% 증가…사고 판...',
              sentiment_description:
                '[CLS] 서학개미, 테슬라 대신 SPY 샀다 … 3분기 외화증권 보관액 2203억달러 [SEP]\n[CLS] 전분기와 비교해도 19 % 늘어 … 보관액 1위는 테슬라 [SEP]\n[CLS] 가장 많이 사고판 주식은 테슬라를 제치고 ‘ SPDR S & P500 ETF 트러스트 ’ ( SPY ) 가 차지했다. [SEP]\n[CLS] 외화주식 보관금액 상위종목은 모두 미국 주식이며 테슬라, 엔비디아, 팔란티어A, 애플, IONQ 순으로 구성됐다. [SEP]\n[CLS] 올해 2분기 외화주식 결제금액 1위 종목은 테슬라였으나 3분기에는 SPDR S & P 500 ETF TRUST가 차지했다. [SEP]',
            },
          ],
          sentiment_score: 0.20723225575123957,
          sentiment_label: 'neutral',
          sentiment_subject: '테슬라',
          sentiment_derivation: 'direct',
        },
        {
          source: '리튬',
          target: '테슬라',
          weight: 0.9736069887876511,
          cooccurrence: 1.0,
          similarity: 0.9472139775753021,
          articles: [
            {
              link: 'https://n.news.naver.com/mnews/article/024/0000100808?sid=102',
              title:
                '한국산 배터리로 무장한 폴스타5...“테슬라·포르쉐, 그동안 애썼다”...',
              pubDate: 'Fri, 24 Oct 2025 21:01:00 +0900',
              trust_score: 0.44715177646857696,
              description:
                '스웨덴 출신 전기차 브랜드인 폴스타가 ‘고성능차의 대명사’ 포르쉐에 맞설 전기차를 내년에 한국에 가져온다. 폴스타는 지난달 9일(현지시간) 독일...',
              sentiment_description:
                '[CLS] 한국산 배터리로 무장한 폴스타5... “ 테슬라 · 포르쉐, 그동안 애썼다 ”... [SEP]\n[CLS] 폴스타2가 테슬라 모델3, 폴스타4가 테슬라 모델Y를 겨냥했다면 폴스타5는 고성능 전기차인 포르쉐 타이칸를 노린다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/293/0000074004?sid=101',
              title:
                "국토부, '테슬라 BMS_a079 오류' 리콜 소극적...&quot;민원 거의 없다&quot;",
              pubDate: 'Fri, 24 Oct 2025 15:50:00 +0900',
              trust_score: 0.44715177646857696,
              description:
                "국토교통부가 테슬라 'BMS_a079' 오류와 관련된 국내 오너들의 불만이 확산된 상황에서 리콜 조치에 소극적이었던 것으로 나타났다. 국회뿐 아...",
              sentiment_description:
                "[CLS] 국토부, ' 테슬라 BMS _ a079 오류 ' 리콜 소극적... & quot ; 민원 거의 없다 & quot ; [SEP]\n[CLS] 국토교통부가 테슬라 ' BMS _ a079 ' 오류와 관련된 국내 오너들의 불만이 확산된 상황에서 리콜 조치에 소극적이었던 것으로 나타났다. [SEP]\n[CLS] 이 관계자는 테슬라가 답변을 주지 않아 답답한 상황이냐고 질문하자 \" 그렇게 봐도 된다 \" 고 짧게 말했다. [SEP]\n[CLS] 테슬라 BMS _ a079 오류 문제는 올 8월부터 공론화됐다. [SEP]\n[CLS] 이 오류가 나타나면 차량 내 배터리관리시스템 ( BMS ) 이 배터리의 최대 충전량을 50 % 정도로 제한하며, 테슬라는 사용자 설명서에 이 같은 문제가 생길 경우 최대한 빠르게 정비를 받아야 한다고 안내하고 있다. [SEP]\n[CLS] 박상혁 더불어민주당 의원실이 제공한 ' 2017 ~ 2025년 테슬라코리아 BMS 오류 ' 데이터에 따르면 국내에서 판매된 테슬라 차량 13만4429대 중 4351대에서 BMS _ a079 오류가 발생했다. [SEP]\n[CLS] 이 같은 국토부의 입장이 지속되고 테슬라코리아가 BMS _ a079 문제에 대해 추가 조치를 취하지 않을 경우 소비자의 불만은 더욱 커질 것으로 전망된다. [SEP]\n[CLS] 테슬라 BMS _ a079 오류 문제에 대한 기후에너지환경부의 움직임은 지난달 24일 의 보도로 처음 알려졌다. [SEP]\n[CLS] 김성환 기후에너지부 장관은 당시 이 오류에 따른 테슬라 오너의 불편을 듣고 이를 해결하기 위한 현황 파악을 부서 담당자에게 지시했다. [SEP]\n[CLS] 업계에서는 기후에너지부가 향후 테슬라의 보조금을 제한하는 조치가 나올 수 있을 것으로 봤지만, 취재 결과 사실이 아닌 것으로 파악됐다. [SEP]\n[CLS] 기후에너지부는 최대한 테슬라를 포함한 각 제조사의 판매현황과 배터리 상태 등을 공정하게 판단해 보조금 지급 방안을 마련할 것으로 전망된다. [SEP]",
            },
            {
              link: 'https://n.news.naver.com/mnews/article/016/0002546020?sid=101',
              title:
                '테슬라, 역대 최대 매출에도 순익 37% 급감…요즘 불장 K-이차전지 때 이...',
              pubDate: 'Thu, 23 Oct 2025 09:29:00 +0900',
              trust_score: 0.42756262292958813,
              description:
                '테슬라 3Q 매출 281억弗…전년比 7% 증가 ‘역대 최대’\nEPS는 0.50弗로 시장 전망 하회…전체 순익 13.7억弗 ‘전년比 37% ↓’...',
              sentiment_description:
                '[CLS] 테슬라, 역대 최대 매출에도 순익 37 % 급감 … 요즘 불장 K - 이차전지 때 이... [SEP]\n[CLS] 테슬라 3Q 매출 281억 [UNK] … 전년 比 7 % 증가 ‘ 역대 최대 ’ [SEP]\n[CLS] [ 헤럴드경제 = 신동윤 기자 ] 서학개미 ( 미국 주식 소액 개인 투자자 ) 최선호주 테슬라가 올해 3분기 역대 최대 수준의 매출을 기록했음에도 불구하고 순이익에선 시장의 눈높이에 못 미치면서 투자자의 불안감이 오히려 커진 모양새다. [SEP]\n[CLS] 글로벌 전기차 ‘ 대장주 ’ 테슬라의 부진이 모처럼 온기가 돌고 있는 K - 이차전지 섹터 주가엔 하방 압력으로 작용할 수밖에 없단 분석도 나온다. [SEP]\n[CLS] 23일 금융투자업계에 따르면 테슬라는 올해 3분기 ( 7 ~ 9월 ) 281억달러 ( 40조2616억원 ) 의 매출을 기록했다고 22일 ( 현지시간 ) 밝혔다. [SEP]\n[CLS] 앞서 테슬라의 3분기 신차 인도량이 전년 동기 대비 7 % 늘어난 49만7099대로 사상 최대치를 기록했을 때부터 예고된 바 있다. [SEP]\n[CLS] 다만, 이날 투자자들은 테슬라의 이익 감소에 초점을 맞췄다. [SEP]\n[CLS] 매출은 늘었지만 기업 이윤이 감소한 게 테슬라가 처한 현실을 여실히 보여줬단 평가가 증권가에선 나왔다. [SEP]\n[CLS] 테슬라는 탄소 배출권 판매 수익 감소도 이익 감소의 요인으로 언급했다. [SEP]\n[CLS] 지난 7월 일론머스크 테슬라 최고경영자 ( CEO ) 는 2분기 실적 발표 당시 세제 혜택 종료와 관세 부담 증가 탓에 “ 회사가 향후 여러 분기 힘들 것 ” 이라고 발언한 적 있다. [SEP]\n[CLS] 테슬라가 악화할 것이란 전망이 우세했던 향후 실적 전망치 ( 가이던스 ) 도 밝히지 않았단 점도 증시엔 불확실성을 키웠단 지적도 나온다. [SEP]\n[CLS] 한 증권업계 관계자는 “ 반도체주 중심의 코스피 ‘ 역대 최고치 ’ 랠리에서 소외됐던 이차전지에 대한 순환매 국면이 불장을 이끈 주요 원동력 ” 이라며 “ 테슬라 실적이 ‘ 어닝 서프라이즈 ( 깜짝 실적 ) ’ 를 기록할 것이란 시장 기대에 크게 못 미친 점은 4분기 전기차 시장 둔화 우려를 더 증폭시킬 수 있다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/008/0005267292?sid=101',
              title:
                '"2차전지 구조대 기다렸는데"…테슬라 실적 부진에 \'급브레이크\'',
              pubDate: 'Thu, 23 Oct 2025 15:55:00 +0900',
              trust_score: 0.42756262292958813,
              description:
                '에코프로 6% 하락…"전기차 배터리 수요 둔화"질주하던 2차전지 주에 제동이 걸렸다. 테슬라가 컨센서스를 밑도는 순이익을 기록하며 하락하자, 국...',
              sentiment_description:
                '[CLS] & quot ; 2차전지 구조대 기다렸는데 & quot ; … 테슬라 실적 부진에 \' 급브레이크 \' [SEP]\n[CLS] 테슬라가 컨센서스를 밑도는 순이익을 기록하며 하락하자, 국내 2차전지 주도 함께 미끄러졌다. [SEP]\n[CLS] 테슬라 3분기 실적이 컨센서스를 하회하고, 주가가 하락하면서 국내 2차전지 투자심리에도 악영향을 끼친 것으로 풀이된다. [SEP]\n[CLS] 22일 ( 현지시각 ) 테슬라는 3분기 EPS ( 주당순이익 ) 가 전년 동기 30. 6 % 감소한 0. 50달러를 기록했다고 발표했다. [SEP]\n[CLS] 송선재 하나증권 연구원은 " 규제 크레딧 매출감소, 구조조정 비용과 개발비, 관세 비용 등이 테슬라 3분기 실적에 부정적인 영향을 줬다 " 며 " 미국이 전기차 세액공제 혜택을 종료한 이후인 만큼 4분기에도 크게 개선되기는 어렵다 " 고 말했다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/025/0003476527?sid=101',
              title:
                '"2815만원 수리비 폭탄" 韓소비자 뒤통수치는 테슬라 배터리 논란',
              pubDate: 'Mon, 20 Oct 2025 18:12:00 +0900',
              trust_score: 0.38309927485744033,
              description:
                '#충남 홍성에 사는 A씨는 지난 8월 2021년식 테슬라 모델3 롱레인지를 타던 중 센터디스플레이에 ‘BMS_a079, 충전 불가. 정비 예약하...',
              sentiment_description:
                '[CLS] & quot ; 2815만원 수리비 폭탄 & quot ; 韓 소비자 뒤통수치는 테슬라 배터리 논란 [SEP]\n[CLS] 테슬라는 2022년부터 LG에너지솔루션의 원통형 NCM 배터리, CATL의 리튬인산철 ( LFP ) 각형 배터리를 장착하는 등 공급사를 다양화했다. [SEP]\n[CLS] # 충남 홍성에 사는 A씨는 지난 8월 2021년식 테슬라 모델3 롱레인지를 타던 중 센터디스플레이에 ‘ BMS _ a079, 충전 불가. [SEP]\n[CLS] 이후 충전용량이 50 % 이하로 제한되자 A씨는 테슬라 서비스센터에 정비를 맡겼고 재제조배터리 ( 리만배터리 ) 로 무상 교체수리를 받았다. [SEP]\n[CLS] # 2021년식 모델Y를 타는 경기 수원 거주 B씨는 ‘ BMS _ a079 ’ 오류로 이달 초 차량을 테슬라 서비스센터에 맡겼다가 ‘ 수리비 2815만원 폭탄 ’ 을 맞았다. [SEP]\n[CLS] 테슬라가 배터리 관리시스템 ( BMS ) 오류로 도마 위에 올랐다. [SEP]\n[CLS] 테슬라는 올해 1 ~ 9월 4만3637대를 판매해 BMW, 메르세데스 - 벤츠에 이은 수입차 판매량 3위에 올랐지만, 품질 이슈와 서비스 대응 문제가 커지고 있다. [SEP]\n[CLS] 20일 박상혁 더불어민주당 의원이 테슬라에서 제출받은 자료에 따르면 2017년부터 올해 9월까지 국내에 판매된 테슬라 차량 13만4429대 중 4351대 ( 3. 2 % ) 에서 BMS _ a079 오류가 발생했다. [SEP]\n[CLS] 업계에서는 2020 ~ 2021년 미국산 테슬라 차량에 장착된 건전지 모양의 원통형 삼원계 ( NCM ) 배터리셀을 문제의 원인으로 꼽는다. [SEP]\n[CLS] 당시 테슬라는 원통형 배터리셀 수천개를 연결해 하나의 배터리팩을 만들었는데, 배터리셀 일부가 전압 이상, 터짐 등으로 고장 날 경우 안전을 위해서 BMS가 오류코드를 띄우고 충전을 50 % 이하로 제한한다. [SEP]\n[CLS] 이호근 대덕대 미래자동차학과 교수는 “ 2020년은 테슬라가 막 글로벌 전기차 시장에서 뛰어들어 대량 생산을 시작한 시점 ” 이라며 “ 설계오류가 있는 파나소닉 배터리를 장착했다가 2022년부터는 개선했을 가능성이 있다 ” 고 했다. [SEP]\n[CLS] 문제는 테슬라의 사후 조치다. [SEP]\n[CLS] 테슬라는 미국에선 2021년식 모델Y · 3에 대해 품질 이슈로 무상수리를 한 적이 있다. [SEP]\n[CLS] 이에 국토교통부는 지난 8월 한국교통안전공단 자동차안전연구원에 테슬라 차종에 대한 BMS 제작 결함 가능성 조사를 의뢰한 상태다. [SEP]\n[CLS] 권용주 국민대 자동차운송디자인학과 교수는 “ 이번 사태로 국내 소비자에겐 ‘ 테슬라가 배짱장사를 한다 ’ 는 인식이 강해졌다 ” 며 “ 만약 테슬라가 해법을 내놓지 않으면, 정부가 강제적 리콜 결정을 통해 소비자 권익을 보호해야 할 것 ” 이라고 말했다. [SEP]',
            },
          ],
          sentiment_score: -0.199917640768316,
          sentiment_label: 'neutral',
          sentiment_subject: '테슬라',
          sentiment_derivation: 'direct',
        },
        {
          source: '관세',
          target: '테슬라',
          weight: 0.9835360050201416,
          cooccurrence: 1.0,
          similarity: 0.9670720100402832,
          articles: [
            {
              link: 'https://n.news.naver.com/mnews/article/008/0005271057?sid=101',
              title: '관세 25%→15%, 증권가 전망도 맑은 자동차주',
              pubDate: 'Thu, 30 Oct 2025 16:21:00 +0900',
              trust_score: 0.6467511599000726,
              description:
                '[오늘의 포인트]\n자동차 관세가 25%에서 경쟁국 수준인 15%로 인하되자 관련주에 화색이 돌았다.\n\n30일 거래소에서 현대차는 전 거래일 대비...',
              sentiment_description:
                '[CLS] 임은영 삼성증권 연구원은 " 현대차와 기아는 자율주행 기술과 로봇 기술이 테슬라나 중국업체에 뒤쳐졌다는 평가를 받으며 AI 모멘텀이 전혀 작동하지 않았다 " 며 " 이날 정의선 현대차그룹 회장과 젠슨 황 엔비디아 CEO ( 최고경영자 ) 미팅을 통해 로봇과 자율주행 분야 협력이 강화되면 AI 스토리가 시작될 것 " 이라고 밝혔다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/052/0002266617?sid=100',
              title: '시진핑 만나는 날 "한국 핵잠 승인"...미·중 관세 \'휴전\'',
              pubDate: 'Thu, 30 Oct 2025 20:56:00 +0900',
              trust_score: 0.6467511599000726,
              description:
                '■ 진행 : 유다원 앵커, 김명근 앵커\n■ 출연 : 석병훈 이화여대 경제학과 교수, 정한범 국방대학교 안전보장대학원 교수\n\n* 아래 텍스트는 실...',
              sentiment_description:
                '[CLS] 제가 볼 때는 현대자동차가 저기 끼었다고 하는 것은 아마도 최근에 테슬라나 이런 쪽의 트랜드를 보면 자동차가 이제 더 이상 모빌리 아니고 운송수단뿐만 아니라 일종의 데이터산업화되어가고 있지 않습니까? [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/001/0015711065?sid=101',
              title:
                '삼성증권 "현대차, 한미협상 타결로 내년 관세 7천800억원 감소"',
              pubDate: 'Thu, 30 Oct 2025 08:46:00 +0900',
              trust_score: 0.6467511599000726,
              description:
                '"실적 피크아웃 논란 불식 전망…저평가 해소시 40만원도 가능"\n\n(서울=연합뉴스) 황철환 기자 = 삼성증권은 도널드 트럼프 미국 대통령의 방한...',
              sentiment_description:
                '[CLS] 임 연구원은 " 현대차 · 기아는 자율주행 기술과 로봇 기술이 테슬라나 중국업체 대비 뒤처졌다는 평가를 받으며 인공지능 ( AI ) 내러티브가 전혀 작동하고 있지 않다 " 면서 엔비디아의 협력이 이뤄진다면 국내 자동차주도 AI 내러티브의 혜택을 받을 가능성이 있다고 내다봤다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/023/0003937924?sid=101',
              title:
                '美 차 업체 관세 부담 확 줄어든 까닭은...“차 부품 수입 땐 관세 환급...',
              pubDate: 'Thu, 30 Oct 2025 17:43:00 +0900',
              trust_score: 0.6467511599000726,
              description:
                '[WEEKLY BIZ] [Weekly Biz 밑줄 짝] GM, 포드, 테슬라의 3분기 실적 분석\n\n\t\t\t\t\t\t\t\t\t\t미국 자동차 업계를 대표하는...',
              sentiment_description:
                '[CLS] [ WEEKLY BIZ ] [ Weekly Biz 밑줄 짝 ] GM, 포드, 테슬라의 3분기 실적 분석 [SEP]\n[CLS] 미국 자동차 업계를 대표하는 제너럴모터스 ( GM ) 와 포드, 미국 전기차 시장 점유율 1위인 테슬라가 지난 21 ~ 23일 잇따라 올해 3분기 실적을 발표했다. [SEP]\n[CLS] 전망 내놓지 않은 테슬라 [SEP]\n[CLS] 반면 테슬라는 역대 최대 매출을 기록하고도 웃지 못했다. [SEP]\n[CLS] 테슬라는 지난 22일 올해 3분기 매출액이 281억달러, 순이익은 13억7000만달러를 기록했다고 밝혔다. [SEP]\n[CLS] 테슬라는 이익이 줄어든 요인으로 구조 조정 비용 증가, 탄소 배출권 판매 수익 감소 등을 꼽았다. [SEP]\n[CLS] 다만 일론 머스크 테슬라 CEO는 “ 내년부터 로보 택시 ‘ 사이버캡 ’ 과 전기 트럭 ‘ 세미 ’, 차세대 에너지 저장 장치 ‘ 메가팩3 ’ 양산을 목표로 하고 있다 ” 고 밝혔다. [SEP]\n[CLS] 테슬라가 투자자들의 기대를 하회하는 실적을 발표하면서 주가는 고전했다. [SEP]\n[CLS] 지난 22일 장 마감 이후 실적을 발표한 테슬라는 시간 외 거래에서 4 % 가까이 빠졌지만, 이튿날에는 2. 3 % 오르며 장을 마쳤다. [SEP]\n[CLS] 전문가들은 미국의 전기차 보조금 종료 전 선구매로 테슬라의 전기차 판매량이 증가했으나 경쟁 심화에 따른 할인 판매와 비용 증가 등으로 시장 기대에 못 미친 것으로 보고 있다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/057/0001914636?sid=101',
              title: '테슬라, 3분기 매출은 최대인데…순이익은 37% 하락',
              pubDate: 'Thu, 23 Oct 2025 07:24:00 +0900',
              trust_score: 0.42756262292958813,
              description:
                '관세·구조조정 비용 등 원인\n일론 머스크가 이끄는 전기차 업체 테슬라는 3분기(7-9월) 281억 달러(40조 2천616억 원)의 매출과 0.5...',
              sentiment_description:
                '[CLS] 테슬라, 3분기 매출은 최대인데 … 순이익은 37 % 하락 [SEP]\n[CLS] 테슬라는 관세와 구조조정 비용 증가, 탄소 배출권 판매 수익 감소를 이익이 줄어든 요인으로 언급했습니다. [SEP]\n[CLS] 테슬라 최고경영자 ( CEO ) 일론 머스크는 지난 7월 2분기 실적 발표 당시 세제 혜택 종료와 관세 부담 증가가 실적에 악영향을 줄 것이라고 우려한 바 있습니다. [SEP]\n[CLS] 테슬라가 향후 실적 전망치는 밝히지 않았습니다. [SEP]\n[CLS] 이날 뉴욕 증시 정규장에서 0. 82 % 내린 테슬라 주가는 실적 발표 후 시간 외 거래에서는 2 % 하락했습니다. [SEP]',
            },
          ],
          sentiment_score: -0.12986147214319477,
          sentiment_label: 'neutral',
          sentiment_subject: '테슬라',
          sentiment_derivation: 'direct',
        },
        {
          source: 'BYD',
          target: '중국',
          weight: 0.3973151743412018,
          cooccurrence: 0.0,
          similarity: 0.7946303486824036,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '테슬라',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: 'BYD',
          target: '리튬',
          weight: 0.43024273216724396,
          cooccurrence: 0.0,
          similarity: 0.8604854643344879,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '테슬라',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: 'BYD',
          target: '관세',
          weight: 0.4337058514356613,
          cooccurrence: 0.0,
          similarity: 0.8674117028713226,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '테슬라',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '리튬',
          target: '중국',
          weight: 0.4248868376016617,
          cooccurrence: 0.0,
          similarity: 0.8497736752033234,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '테슬라',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '관세',
          target: '중국',
          weight: 0.44736677408218384,
          cooccurrence: 0.0,
          similarity: 0.8947335481643677,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '테슬라',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '관세',
          target: '리튬',
          weight: 0.4428205192089081,
          cooccurrence: 0.0,
          similarity: 0.8856410384178162,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '테슬라',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
      ],
      metadata: { total_nodes: 5, total_edges: 10 },
    };
  }

  private async dummyAgentCall_second(): Promise<{
    nodes: Array<{ id: string; importance: number }>;
    edges: Array<{
      source: string;
      target: string;
      weight: number;
      cooccurrence: number;
      similarity: number;
      articles: Array<{
        link: string;
        title: string;
        pubDate: string;
        trust_score: number;
        description: string;
        sentiment_description: string;
      }>;
      sentiment_score: number;
      sentiment_label: 'positive' | 'neutral' | 'negative' | string;
      sentiment_subject: string;
      sentiment_derivation: 'direct' | 'propagated' | string;
      hops_to_main?: number;
    }>;
    metadata: { total_nodes: number; total_edges: number };
  }> {
    return {
      nodes: [
        {
          id: '엔비디아',
          importance: 0.784914478756036,
        },
        {
          id: '데이터센터',
          importance: 0.9708149706890371,
        },
        {
          id: '중국',
          importance: 1.0,
        },
        {
          id: '한국',
          importance: 0.8812832536799889,
        },
        {
          id: '이재용',
          importance: 0.8973196610419835,
        },
        {
          id: '칩',
          importance: 0.9901412948171255,
        },
        {
          id: '정의선',
          importance: 0.8930310250938611,
        },
        {
          id: '블랙웰',
          importance: 0.9571239239031408,
        },
        {
          id: '캠브리콘',
          importance: 0.9312269055770358,
        },
      ],
      edges: [
        {
          source: '엔비디아',
          target: '이재용',
          weight: 0.9393911808729172,
          cooccurrence: 1.0,
          similarity: 0.8787823617458344,
          articles: [
            {
              link: 'https://n.news.naver.com/mnews/article/469/0000896168?sid=102',
              title:
                "젠슨 황 만난 이재용, 이번엔 벤츠 회장...'전장' 협력 가능성↑",
              pubDate: 'Thu, 06 Nov 2025 18:31:00 +0900',
              trust_score: 0.7,
              description:
                "칼레니우스 벤츠 회장 다음 주 방한\n이재용 회장과 회동 일정 조율 중\n\n젠슨 황 엔비디아 최고경영자(CEO)와 만나 최신 '그래픽처리장치(GPU...",
              sentiment_description:
                "[CLS] 젠슨 황 엔비디아 최고경영자 ( CEO ) 와 만나 최신 ' 그래픽처리장치 ( GPU ) ' 빅딜을 해낸 이재용 삼성전자 회장이 다음 주 올라 칼레니우스 메르세데스 - 벤츠 회장과 만난다. [SEP]",
            },
            {
              link: 'https://n.news.naver.com/mnews/article/016/0002553435?sid=101',
              title:
                '“고맙다 깐부” 국민연금, 엔비디아 ‘덕’ 쏠쏠…美 주식투자로 3개월...',
              pubDate: 'Thu, 06 Nov 2025 07:36:00 +0900',
              trust_score: 0.7,
              description:
                '美주식 552개 종목 186조원 보유…3개월새 평가액 11.2% 증가\n엔비디아서 가장 큰 수익…애플·테슬라 등 대부분 종목서 보유주식 늘려\n\n젠...',
              sentiment_description:
                '[CLS] “ 고맙다 깐부 ” 국민연금, 엔비디아 ‘ 덕 ’ 쏠쏠 … 美 주식투자로 3개월... [SEP]\n[CLS] 젠슨 황 엔비디아 최고경영자와 이재용 삼성전자 회장, 정의선 현대차그룹 회장이 지난달 30일 서울 코엑스에서 열린 엔비디아의 그래픽카드 ( GPU ) ‘ 지포스 ’ 출시 25주년 행사에 참석해 있다. [SEP]\n[CLS] 엔비디아서 가장 큰 수익 … 애플 · 테슬라 등 대부분 종목서 보유주식 늘려 [SEP]\n[CLS] 특히 가장 큰 수익을 안겨준 종목은 엔비디아로 나타났다. [SEP]\n[CLS] 눈에 띄는 수익률의 일등공신은 엔비디아로, 평가액이 가장 큰 폭으로 증가한 것으로 나타났다. [SEP]\n[CLS] 국민연금의 미국주식 포트폴리오 비중 1위는 엔비디아 ( 7. 2 % ), 이어 애플 ( 5. 9 % ), 마이크로소프트 ( 5. 7 % ), 아마존닷컴 ( 3. 2 % ), 메타플랫폼 ( 2. 5 % ) 순이었다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/018/0006157269?sid=101',
              title: "엔비디아·삼성도 주목…폭풍질주 '코스닥 따블주' 정체는",
              pubDate: 'Thu, 06 Nov 2025 09:17:00 +0900',
              trust_score: 0.7,
              description:
                '공모가 대비 7배 오른 노타, 4거래일 연속 급등[특징주][이데일리 권오석 기자] 인공지능(AI) 경량화 및 최적화 기술 기업 노타(486990...',
              sentiment_description:
                "[CLS] 엔비디아 · 삼성도 주목 … 폭풍질주 ' 코스닥 따블주 ' 정체는 [SEP]\n[CLS] 젠슨 황 엔비디아 최고경영자와 이재용 삼성전자 회장이 30일 서울 코엑스에서 열린 엔비디아의 그래픽카드 ( GPU ) ‘ 지포스 ’ 출시 25주년 행사에 참석해 있다 ( 사진 = 이데일리 김태형 기자 ) 6일 엠피닥터에 따르면, 노타는 이날 오전 9시 10분 기준으로 전 거래일 대비 22. 37 % 오른 6만 4000원에 거래되고 있다. [SEP]\n[CLS] 엔비디아, 삼성전자, 퀄컴, Arm 등 글로벌 기술 기업들과 협력하며 AI 생태계를 확장하고, 경량화 · 최적화 분야의 표준화를 선도하고 있다는 설명이다. [SEP]",
            },
            {
              link: 'https://n.news.naver.com/mnews/article/009/0005585850?sid=101',
              title:
                '“깐부회동처럼 이번에도 깜짝 결과 나올까”…이재용, 내주 벤츠 회장...',
              pubDate: 'Thu, 06 Nov 2025 16:21:00 +0900',
              trust_score: 0.7,
              description:
                '이재용 삼성전자 회장이 내주 올라 칼레니우스 메르세데스-벤츠 회장을 만나는 것으로 전해졌다.\n\n6일 재계 등에 따르면 이 회장은 내주 메르세데스...',
              sentiment_description:
                '[CLS] 앞서 젠슨 황 엔비디아 최고경영자 ( CEO ) 와 이 회장, 정의선 현대차그룹 회장 간 ‘ 치킨 회동 ’ 에서 깜짝 성과가 있던 만큼 이번 칼레니우스 회장과의 회동도 귀추가 주목된다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/243/0000087530?sid=101',
              title:
                "&quot;그날의 치맥 그대로!&quot; 깐부치킨, 젠슨 황·이재용·정의선 회동 메뉴 '...",
              pubDate: 'Wed, 05 Nov 2025 10:20:00 +0900',
              trust_score: 0.6467511599000726,
              description:
                "수익금 10% 기부까지[이코노미스트 우승민 기자] 삼성·현대차·엔비디아의 'AI 동맹 치맥 회동'이 치킨 세트로 부활했다.\n\n깐부치킨이 젠슨 황...",
              sentiment_description:
                "[CLS] 깐부치킨이 젠슨 황 엔비디아 CEO, 이재용 삼성전자 회장, 정의선 현대차그룹 회장이 함께한 비공식 치맥 회동 메뉴를 그대로 재현한 ' AI깐부 세트 ' 를 출시하며 관심을 모으고 있다. [SEP]\n[CLS] 수익금 10 % 기부까지 [ 이코노미스트 우승민 기자 ] 삼성 · 현대차 · 엔비디아의 ' AI 동맹 치맥 회동 ' 이 치킨 세트로 부활했다. [SEP]",
            },
          ],
          sentiment_score: 0.31457064460724765,
          sentiment_label: 'positive',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'direct',
        },
        {
          source: '엔비디아',
          target: '한국',
          weight: 0.9394712299108505,
          cooccurrence: 1.0,
          similarity: 0.878942459821701,
          articles: [
            {
              link: 'https://n.news.naver.com/mnews/article/001/0015726733?sid=102',
              title:
                '[샷!] &quot;젠슨황, 용산서 뭐든 팔려고 돌아다녔을 것&quot;',
              pubDate: 'Thu, 06 Nov 2025 05:50:00 +0900',
              trust_score: 0.7,
              description:
                '젠슨 황, 1990~2000년대 용산 전자상가 찾아 GPU 영업\n상인들 "그때는 아무것도 아니었던 사람인데 지금은…"\n"과거 그를 봤겠지만 유명...',
              sentiment_description:
                '[CLS] 젠슨 황 엔비디아 CEO ( 최고경영자 ) 가 15년만의 한국 방문에서 엄청난 화제를 불러 모으면서 그와 한국의 오랜 인연이 다시금 주목받았다. [SEP]\n[CLS] 젠슨 황 " 한국이 엔비디아의 시작부터 핵심 역할 " 황 CEO는 그간 엔비디아를 세계 인공지능 ( AI ) 기술 생태계의 중심으로 키워내는 여정의 출발점에서 용산 전자상가를 여러차례 방문했던 경험을 밝혀왔다. [SEP]\n[CLS] APEC 정상회의를 계기로 한국을 찾은 황 CEO는 지난달 30일 코엑스에서 열린 엔비디아 그래픽카드 ( GPU ) \' 지포스 \' 의 한국 출시 25주년 행사에서는 " 엔비디아의 첫 시장은 PC 게임이었고 한국은 스포츠라는 새로운 혁명의 중심지로 엔비디아는 한국에 아주 오래 머물렀다 " 고 언급하며 PC방을 한국어로 \' 피시방 \' 이라고 발음하기도 했다. [SEP]\n[CLS] 그는 " 엔비디아가 발명한 GPU, 지싱크 ( G - SYNC ), 저지연 리플렉스 등은 모두 e스포츠 덕분이고 한국 덕분 " 이라며 AI의 핵심 인프라로 꼽히는 그래픽처리장치 ( GPU ) 등이 e스포츠와 한국 덕분이라고 공을 돌렸다. [SEP]\n[CLS] 1993년 엔비디아를 창업한 황 CEO는 2000년대까지 한국에 올 때마다 용산 전자상가를 찾은 것으로 알려졌다. [SEP]\n[CLS] 이와 함께 엔비디아가 황 CEO의 한국 방문에 맞춰 지난달 31일 ( 현지시간 ) 유튜브 공식 계정에 올린 한국 헌정 영상 \' 한국의 차세대 산업혁명 \' 은 5일 현재 조회수 60만회를 기록하며 해외에서도 화제다. [SEP]\n[CLS] 하지만 스타크래프트 유행 이전에는 엔비디아가 중소기업 정도도 안 되는 소규모 업체였고, 이곳을 찾는 사람이 한둘이 아니었던 만큼 기억에 남지는 않아요. [SEP]\n[CLS] 같은 층의 한 컴퓨터 조립 · 수리 업체 사장 A씨는 " 젠슨 황이 용산 전자상가를 찾았을 당시는 엔비디아 제품군이 다변화되고 있는 시점이었다 " 며 " 아마도 그는 ( 일반 매장보다는 ) 엔비디아 총판에나 들렀을 것 " 이라고 말했다. [SEP]\n[CLS] 그러면서 " 지금도 엔비디아가 그래픽카드 업계에서는 압도적인 만큼 게임용 컴퓨터를 구하는 이들은 견적을 100만원으로 잡으면 그중 50만원 정도는 엔비디아 그래픽카드에 쓴다 " 고 설명했다. [SEP]\n[CLS] 과거에는 PC방에 들어가는 PC를 주로 용산 전자상가에서 조립했고, 엔비디아로서는 그 PC에 들어가는 GPU를 판매하는 영업이 중요했다. [SEP]\n[CLS] 3일 찾은 노량진역 인근 한 PC방은 2018년 출시된 엔비디아 그래픽카드 \' RTX2080 \' 을 구비하고 있다는 홍보 현수막을 내걸고 있었다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/057/0001917359?sid=100',
              title:
                '김민석 총리 &quot;엔비디아 GPU 26만장 공급, 약속대로 진행&quot;',
              pubDate: 'Thu, 06 Nov 2025 16:14:00 +0900',
              trust_score: 0.7,
              description:
                '"블랙웰만 100% 공급 아닐수도"\n엔비디아가 한국 정부와 기업에 공급하기로 한 그래픽처리장치(CPU) 26만 장과 관련해 김민석 국무총리가 "...',
              sentiment_description:
                '[CLS] 김민석 총리 & quot ; 엔비디아 GPU 26만장 공급, 약속대로 진행 & quot ; [SEP]\n[CLS] 엔비디아가 한국 정부와 기업에 공급하기로 한 그래픽처리장치 ( CPU ) 26만 장과 관련해 김민석 국무총리가 " 결국은 다 민간에서 약속한 대로 진행이 될 것 " 이라고 말했습니다. [SEP]\n[CLS] 김 총리는 오늘 ( 6일 ) 오후 국회에서 열린 예산결산특별위원회 전체회에서 " 엔비디아가 26만 장의 칩을 한국에 공급하겠다고 했지만, 도널드 트럼프 미국 대통령이 \' 최신 칩은 미국 기업에만 제공하겠다 \' 고 말했는데 어느 말을 믿어야 하느냐 " 는 김대식 국민의힘 의원 질문에 이같이 답변했습니다. [SEP]\n[CLS] 앞서 엔비디아는 젠슨 황 최고경영자 ( CEO ) 의 지난달 31일 아시아경제협력체 ( APEC ) 에서 한국 정부와 삼성전자, SK그룹, 현대차그룹, 네이버클라우드 등에 26만 장의 GPU를 공급한다고 발표했습니다. [SEP]\n[CLS] 이어 " 트럼프 대통령이 말한 다음 날에도 엔비디아에서 아랍에미리트 ( UAE ) 에 칩을 선적한 사례가 있다 " 고 설명했습니다. [SEP]\n[CLS] # 김민석 # 엔비디아 # GPU # 블랙웰 # APEC # 젠슨황 [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/366/0001120855?sid=100',
              title: '金총리 “엔비디아 GPU 26만장 공급 약속대로 진행될 것”',
              pubDate: 'Thu, 06 Nov 2025 16:56:00 +0900',
              trust_score: 0.7,
              description:
                '김민석 국무총리는 엔비디아가 한국 정부와 기업에 약속한 그래픽처리장치(GPU) 공급과 관련해 약속대로 진행될 것이라고 밝혔다....',
              sentiment_description:
                '[CLS] 金 총리 “ 엔비디아 GPU 26만장 공급 약속대로 진행될 것 ” [SEP]\n[CLS] 김민석 국무총리는 엔비디아가 한국 정부와 기업에 약속한 그래픽처리장치 ( GPU ) 공급과 관련해 약속대로 진행될 것이라고 밝혔다. [SEP]\n[CLS] 예결위 소속 김대식 국민의힘 의원은 김 총리에게 ‘ 엔비디아가 GPU 26만장을 한국에 공급한다고 했지만, 도널드 트럼프 미국 대통령은 블랙웰은 미국기업에만 제공한다고 한다 ’ 라고 질문했다. [SEP]\n[CLS] 다만 트럼프 대통령이 “ ( 엔비디아 GPU 중 ) 최첨단 ( 블랙웰 ) 은 미국 말고는 누구도 갖지 못하게 할 것 ” 이라고 말해 한국도 공급에 차질을 빚는 게 아니냐는 우려가 나왔다. [SEP]\n[CLS] 김 총리는 김 의원의 질의에 “ GPU 26만장이 블랙웰만은 아닌 것으로 볼 수 있다 ” 면서 “ 트럼프 대통령이 말한 다음 날에도 엔비디아에서 아랍에미리트 ( UAE ) 로 보내기 위한 칩을 선적까지 한 것으로 안다 ” 고 답했다. [SEP]\n[CLS] 앞서 정부는 지난달 젠슨 황 최고경영자 ( CEO ) 가 경주 아시아태평양경제협력체 ( APEC ) 를 계기로 방한한 당시 엔비디아가 국내에 총 26만장의 GPU를 공급하기로 했다고 발표했다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/421/0008589796?sid=100',
              title:
                '金총리 &quot;엔비디아 GPU 26만건 공급, 약속대로 진행될 것&quot;',
              pubDate: 'Thu, 06 Nov 2025 16:47:00 +0900',
              trust_score: 0.7,
              description:
                '"트럼프 대통령 발언 후 UAE 선적 케이스…우려는 충분히 이해"\n\n(서울=뉴스1) 이기림 임윤지 기자 = 김민석 국무총리는 6일 엔비디아가 한...',
              sentiment_description:
                '[CLS] 金 총리 & quot ; 엔비디아 GPU 26만건 공급, 약속대로 진행될 것 & quot ; [SEP]\n[CLS] ( 서울 = 뉴스1 ) 이기림 임윤지 기자 = 김민석 국무총리는 6일 엔비디아가 한국에 공급하기로 약속한 그래픽처리장치 ( GPU ) 26만 건 공급에 관해 " 결국은 민간에서 약속한 대로 진행될 것 " 이라고 밝혔다. [SEP]\n[CLS] 앞서 젠슨 황 엔비디아 최고경영자 ( CEO ) 가 지난달 방한해 한국 정부 및 삼성전자, SK그룹, 현대차그룹, 네이버클라우드에 총 26만 장의 GPU를 공급한다고 발표했다. [SEP]\n[CLS] 김 총리는 " 엔비디아에서 공급받기로 한 GPU 26만 장이 다 ( 최신형인 ) 블렉웰만 100 % 되는 건 아니라고 볼 수도 있다 " 고 밝혔다. [SEP]\n[CLS] 다만 김 총리는 " 트럼프 대통령이 그 말을 한 다음 날에도 엔비디아에서 아랍에미리트 ( UAE ) 에 칩을 선적한 케이스가 있다 " 며 " 우려하는 건 충분히 이해한다 " 고 밝혔다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/056/0012061358?sid=100',
              title: '김 총리 “엔비디아 GPU 26만 장 공급, 약속대로 진행될 것”',
              pubDate: 'Thu, 06 Nov 2025 18:23:00 +0900',
              trust_score: 0.7,
              description:
                '엔비디아가 한국 정부와 기업에 약속한 그래픽처리장치(GPU) 공급과 관련해 약속한 대로 진행될 것이라고 김민석 총리가 밝혔습니다.\n\n김 총리는...',
              sentiment_description:
                '[CLS] 김 총리 “ 엔비디아 GPU 26만 장 공급, 약속대로 진행될 것 ” [SEP]\n[CLS] 엔비디아가 한국 정부와 기업에 약속한 그래픽처리장치 ( GPU ) 공급과 관련해 약속한 대로 진행될 것이라고 김민석 총리가 밝혔습니다. [SEP]\n[CLS] 앞서 정부는 경주 APEC 계기에 방한한 젠슨 황 엔비디아 최고경영자가 국내에 총 26만 장의 GPU를 공급하기로 했다고 발표했으나, 트럼프 대통령이 엔비디아 GPU 중 최첨단 ( 블랙웰 ) 은 미국만 보유하게 할 것이라는 취지로 말해 한국도 공급에 차질을 빚는 게 아니냐는 우려가 나왔습니다. [SEP]\n[CLS] 이와 관련해 김 총리는 “ 트럼프 대통령이 말한 다음 날에도 엔비디아에서 아랍에미리트 ( UAE ) 에 칩을 선적한 사례가 있다 ” 고 설명했습니다. [SEP]',
            },
          ],
          sentiment_score: 0.30345622494797625,
          sentiment_label: 'positive',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'direct',
        },
        {
          source: '엔비디아',
          target: '중국',
          weight: 0.9697090089321136,
          cooccurrence: 1.0,
          similarity: 0.9394180178642273,
          articles: [
            {
              link: 'https://n.news.naver.com/mnews/article/214/0001460027?sid=104',
              title:
                '&quot;美, 중국시장 진출 안 하나&quot;‥젠슨황 &quot;이러면 져&quot; 직격',
              pubDate: 'Thu, 06 Nov 2025 15:00:00 +0900',
              trust_score: 0.7,
              description:
                '엔비디아 최고경영자 젠슨 황이 AI 경쟁의 최종 승자는 결국 미국이 아니라 중국이 될 것이라고 전망했습니다.\n\n젠슨 황은 현지시간 5일 영국 런...',
              sentiment_description:
                '[CLS] 엔비디아 최고경영자 젠슨 황이 AI 경쟁의 최종 승자는 결국 미국이 아니라 중국이 될 것이라고 전망했습니다. [SEP]\n[CLS] 엔비디아의 AI 칩이 연산 능력과 전력 효율성 측면에서 강점을 가지고 있지만, 중국 역시 AI 칩을 만들고 있는데 여기에 전력을 압도적으로 싸게 공급해주면 엔비디아 칩만의 강점을 상당 부분 상쇄할 수 있다는 겁니다. [SEP]\n[CLS] 젠슨 황의 이 같은 발언은 도널드 트럼프 미국 대통령이 이달 초 엔비디아의 최첨단 칩의 중국 수출금지를 계속 유지하겠다고 밝힌 뒤 나왔습니다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/001/0015726856?sid=104',
              title:
                '첨단칩 중국 판매금지에…젠슨황 &quot;중국, AI 경쟁서 미국 제칠것&quot;',
              pubDate: 'Thu, 06 Nov 2025 07:57:00 +0900',
              trust_score: 0.7,
              description:
                '"서방, 기술 냉소주의에 빠져…전기 무료로 쓰는 중국과 대조적"\n\n    (샌프란시스코=연합뉴스) 권영전 특파원 = 세계 1위 인공지능(AI)...',
              sentiment_description:
                '[CLS] ( 샌프란시스코 = 연합뉴스 ) 권영전 특파원 = 세계 1위 인공지능 ( AI ) 칩 생산기업 엔비디아의 젠슨 황 최고경영자 ( CEO ) 가 AI 경쟁에서 중국이 미국에 승리할 것이라고 경고했다. [SEP]\n[CLS] 그러면서 그는 " ( 중국에서는 ) 전기가 무료 " 라며 중국이 기술 기업들에 지급하는 에너지 보조금 때문에 현지 기술기업이 엔비디아 AI 칩의 대체품을 훨씬 저렴하게 운용할 수 있다고 지적했다. [SEP]\n[CLS] 일반적으로 엔비디아 고성능 칩이 연산 능력과 전력 효율성 면에서 화웨이 등 중국산 칩을 압도하는 것으로 평가된다. [SEP]\n[CLS] 하지만 중국이 에너지 보조금을 지급한다면 기업들이 화웨이 칩을 쓰면서도 에너지 비용을 많이 부담하지 않게 되면서 엔비디아 칩의 장점이 일정 부분 상쇄된다는 것이다. [SEP]\n[CLS] 황 CEO의 이와 같은 발언은 도널드 트럼프 대통령이 엔비디아의 최첨단 칩의 중국 수출금지를 계속 고수하겠다는 방침을 밝힌 이후 나온 것이다. [SEP]\n[CLS] 그러나 트럼프 대통령은 CBS 방송과 인터뷰에서 엔비디아의 최첨단 칩의 중국 판매를 허락하겠느냐는 질문에 " 그렇게 하지 않을 것 " 이라며 " 최첨단 칩은 미국 외에는 누구도 갖지 못하게 하겠다 " 고 답했다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/277/0005675297?sid=104',
              title: '젠슨 황 &quot;中, AI 경쟁서 美 상대로 승리할 것&quot;',
              pubDate: 'Thu, 06 Nov 2025 09:03:00 +0900',
              trust_score: 0.7,
              description:
                '"서방, 냉소주의…전기 무료 中과 대조적젠슨 황 엔비디아 최고경영자(CEO)가 인공지능(AI) 경쟁에서 중국이 미국을 상대로 승리할 것이라고 경...',
              sentiment_description:
                '[CLS] " 서방, 냉소주의 … 전기 무료 中 과 대조적젠슨 황 엔비디아 최고경영자 ( CEO ) 가 인공지능 ( AI ) 경쟁에서 중국이 미국을 상대로 승리할 것이라고 경고했다. [SEP]\n[CLS] 그는 중국 정부가 자국산 AI 칩을 사용할 수 있는 기업 친화적 환경을 조성한다며 엔비디아 AI 칩 대신 자국산 제품을 사용하는 기업에 에너지 보조금을 지급하는 정책을 예시로 들며 미국과 비교했다. [SEP]\n[CLS] 엔비디아 칩은 현재 연산 능력과 전력 효율성 등 측면에서 화웨이를 비롯한 중국산 칩보다 크게 앞서 있다는 평가를 받는다. [SEP]\n[CLS] 그러나 중국 정부가 에너지 보조금을 지급한다면 기업들이 중국산 칩을 사용하더라도 에너지 비용 부담이 줄어들기 때문에 엔비디아 칩을 사용할 유인이 사라진다는 설명이다. [SEP]\n[CLS] 지난 2일 방영된 CBS 방송과의 인터뷰에서 엔비디아의 최첨단 칩의 중국 판매를 허용하겠느냐는 질문에 " 최첨단 칩은 미국 외에는 누구도 갖지 못하게 하겠다 " 고 답했다. [SEP]\n[CLS] 지방 정부들이 자국산 칩을 사용하면 엔비디아보다 에너지 효율이 떨어져 데이터센터 운영비 부담이 크다는 업계 불만을 접수한 뒤 인센티브를 확대했다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/031/0000978447?sid=105',
              title:
                '젠슨 황 엔비디아 &quot;중국이 AI 경쟁에서 미국 이길 것&quot;',
              pubDate: 'Thu, 06 Nov 2025 09:53:00 +0900',
              trust_score: 0.7,
              description:
                '트럼프 "엔비디아 칩, 중국에 수출 금지" 발언 이후 나와\n황 CEO, 미국 냉소주의 지적⋯"더 많은 낙관주의 필요"세계 1위 인공지능(AI)...',
              sentiment_description:
                '[CLS] 젠슨 황 엔비디아 & quot ; 중국이 AI 경쟁에서 미국 이길 것 & quot ; [SEP]\n[CLS] 트럼프 " 엔비디아 칩, 중국에 수출 금지 " 발언 이후 나와 [SEP]\n[CLS] 황 CEO, 미국 냉소주의 [UNK] " 더 많은 낙관주의 필요 " 세계 1위 인공지능 ( AI ) 칩 생산기업인 젠슨 황 엔비디아 최고경영자 ( CEO ) 가 AI 경쟁에서 중국이 미국에 이길 것이라고 경고했다. [SEP]\n[CLS] 황 CEO의 발언은 도널드 트럼프 미국 대통령이 지난주 시진핑 중국 국가주석과의 회담 이후에도, 캘리포니아에 본사를 둔 엔비디아가 자사의 최첨단 칩을 베이징에 판매하는 것을 금지하는 조치를 유지한 것에 이어 나왔다. [SEP]\n[CLS] 또 " ( 중국에서는 ) 전기가 무료 " 라며 중국이 기술 기업에 주는 에너지 보조금 때문에 현지 기술 기업이 엔비디아 AI 칩의 대체품을 더 저렴하게 운용할 수 있을 거라고 지적했다. [SEP]\n[CLS] 또 중국 내 지방 정부들은 화웨이, 캠브리콘 같은 국산 반도체의 에너지 효율이 엔비디아 제품보다 낮아 비용이 높다는 기술 기업들의 불만 이후, 전력 인센티브를 강화했다. [SEP]\n[CLS] 하지만 트럼프 대통령은 시 주석과의 회담 이후 " 엔비디아의 최첨단 블랙웰 ( Blackwell ) 칩을 중국이 쓰도록 놔두지 않겠다 " 고 말했다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/366/0001120582?sid=104',
              title: '엔비디아 젠슨 황 “中, AI 경쟁에서 美 이길 것”',
              pubDate: 'Thu, 06 Nov 2025 08:02:00 +0900',
              trust_score: 0.7,
              description:
                '“서방 냉소주의가 AI 발전 가로막아”\n\n        세계 1위 반도체 기업 엔비디아 최고경영자(CEO) 젠슨 황이 5일(현지시각) 중국이 낮...',
              sentiment_description:
                '[CLS] 엔비디아 젠슨 황 “ 中, AI 경쟁에서 美 이길 것 ” [SEP]\n[CLS] 세계 1위 반도체 기업 엔비디아 최고경영자 ( CEO ) 젠슨 황이 5일 ( 현지시각 ) 중국이 낮은 에너지 비용과 유연한 규제를 바탕으로 AI 경쟁에서 미국과 유럽을 제칠 것이라고 밝혔다. [SEP]\n[CLS] 현재 엔비디아와 경쟁사 AMD는 중국 시장용으로 따로 제작한 저 ( 低 ) 성능 AI 칩 매출 15 % 를 미 정부에 지불하기로 합의한 상태다. [SEP]\n[CLS] 젠슨 황의 이번 작심 발언은 엔비디아가 처한 ‘ 정치 · 경제적 딜레마 ’ 를 고스란히 반영한다. [SEP]\n[CLS] 엔비디아는 현재 AI 칩 시장의 80 % 이상을 장악한 독점적 기업이다. [SEP]\n[CLS] 당초 트럼프 대통령은 엔비디아의 최신예 AI 칩 ‘ 블랙웰 ( Blackwell ) ’ 판매 문제를 시 주석과 논의할 수 있다고 시사했다. [SEP]\n[CLS] 하지만 주요 매체에 따르면 이번 회담에서 엔비디아 칩 문제는 끝내 논의되지 않은 것으로 알려졌다. [SEP]',
            },
          ],
          sentiment_score: 0.15548870552131944,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'direct',
        },
        {
          source: '엔비디아',
          target: '칩',
          weight: 0.9741507768630981,
          cooccurrence: 1.0,
          similarity: 0.9483015537261963,
          articles: [
            {
              link: 'https://n.news.naver.com/mnews/article/001/0015726856?sid=104',
              title:
                '첨단칩 중국 판매금지에…젠슨황 &quot;중국, AI 경쟁서 미국 제칠것&quot;',
              pubDate: 'Thu, 06 Nov 2025 07:57:00 +0900',
              trust_score: 0.7,
              description:
                '"서방, 기술 냉소주의에 빠져…전기 무료로 쓰는 중국과 대조적"\n\n    (샌프란시스코=연합뉴스) 권영전 특파원 = 세계 1위 인공지능(AI)...',
              sentiment_description:
                '[CLS] ( 샌프란시스코 = 연합뉴스 ) 권영전 특파원 = 세계 1위 인공지능 ( AI ) 칩 생산기업 엔비디아의 젠슨 황 최고경영자 ( CEO ) 가 AI 경쟁에서 중국이 미국에 승리할 것이라고 경고했다. [SEP]\n[CLS] 그러면서 그는 " ( 중국에서는 ) 전기가 무료 " 라며 중국이 기술 기업들에 지급하는 에너지 보조금 때문에 현지 기술기업이 엔비디아 AI 칩의 대체품을 훨씬 저렴하게 운용할 수 있다고 지적했다. [SEP]\n[CLS] 일반적으로 엔비디아 고성능 칩이 연산 능력과 전력 효율성 면에서 화웨이 등 중국산 칩을 압도하는 것으로 평가된다. [SEP]\n[CLS] 하지만 중국이 에너지 보조금을 지급한다면 기업들이 화웨이 칩을 쓰면서도 에너지 비용을 많이 부담하지 않게 되면서 엔비디아 칩의 장점이 일정 부분 상쇄된다는 것이다. [SEP]\n[CLS] 황 CEO의 이와 같은 발언은 도널드 트럼프 대통령이 엔비디아의 최첨단 칩의 중국 수출금지를 계속 고수하겠다는 방침을 밝힌 이후 나온 것이다. [SEP]\n[CLS] 그러나 트럼프 대통령은 CBS 방송과 인터뷰에서 엔비디아의 최첨단 칩의 중국 판매를 허락하겠느냐는 질문에 " 그렇게 하지 않을 것 " 이라며 " 최첨단 칩은 미국 외에는 누구도 갖지 못하게 하겠다 " 고 답했다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/277/0005675297?sid=104',
              title: '젠슨 황 &quot;中, AI 경쟁서 美 상대로 승리할 것&quot;',
              pubDate: 'Thu, 06 Nov 2025 09:03:00 +0900',
              trust_score: 0.7,
              description:
                '"서방, 냉소주의…전기 무료 中과 대조적젠슨 황 엔비디아 최고경영자(CEO)가 인공지능(AI) 경쟁에서 중국이 미국을 상대로 승리할 것이라고 경...',
              sentiment_description:
                '[CLS] 그는 중국 정부가 자국산 AI 칩을 사용할 수 있는 기업 친화적 환경을 조성한다며 엔비디아 AI 칩 대신 자국산 제품을 사용하는 기업에 에너지 보조금을 지급하는 정책을 예시로 들며 미국과 비교했다. [SEP]\n[CLS] 엔비디아 칩은 현재 연산 능력과 전력 효율성 등 측면에서 화웨이를 비롯한 중국산 칩보다 크게 앞서 있다는 평가를 받는다. [SEP]\n[CLS] 그러나 중국 정부가 에너지 보조금을 지급한다면 기업들이 중국산 칩을 사용하더라도 에너지 비용 부담이 줄어들기 때문에 엔비디아 칩을 사용할 유인이 사라진다는 설명이다. [SEP]\n[CLS] 지방 정부들이 자국산 칩을 사용하면 엔비디아보다 에너지 효율이 떨어져 데이터센터 운영비 부담이 크다는 업계 불만을 접수한 뒤 인센티브를 확대했다. [SEP]\n[CLS] 지난 2일 방영된 CBS 방송과의 인터뷰에서 엔비디아의 최첨단 칩의 중국 판매를 허용하겠느냐는 질문에 " 최첨단 칩은 미국 외에는 누구도 갖지 못하게 하겠다 " 고 답했다. [SEP]\n[CLS] " 서방, 냉소주의 … 전기 무료 中 과 대조적젠슨 황 엔비디아 최고경영자 ( CEO ) 가 인공지능 ( AI ) 경쟁에서 중국이 미국을 상대로 승리할 것이라고 경고했다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/057/0001917239?sid=104',
              title:
                '첨단칩 중국 판매금지에…젠슨황 &quot;중국, AI서 미국 앞설 것&quot;',
              pubDate: 'Thu, 06 Nov 2025 08:17:00 +0900',
              trust_score: 0.7,
              description:
                '"서방, 기술 냉소주의에 빠져…전기 무료로 쓰는 중국과 대조적"\n세계 1위 인공지능(AI) 칩 생산기업 엔비디아의 젠슨 황 최고경영자(CEO)가...',
              sentiment_description:
                '[CLS] 세계 1위 인공지능 ( AI ) 칩 생산기업 엔비디아의 젠슨 황 최고경영자 ( CEO ) 가 AI 경쟁에서 중국이 미국에 승리할 것이라고 경고했습니다. [SEP]\n[CLS] 황 CEO는 또 " 중국에서는 전기가 무료 " 라며, 중국이 기술 기업에 지급하는 에너지 보조금으로 인해 현지 기업들이 엔비디아 AI 칩의 대체품을 훨씬 저렴하게 운용할 수 있다고 설명했습니다. [SEP]\n[CLS] 일반적으로 엔비디아의 고성능 칩은 연산 능력과 전력 효율성 면에서 화웨이 등 중국산 칩을 압도하는 것으로 평가됩니다. [SEP]\n[CLS] 하지만 중국이 에너지 보조금을 지급하면 기업들이 화웨이 칩을 쓰면서도 에너지 비용 부담을 줄일 수 있어 엔비디아 칩의 장점이 일정 부분 상쇄된다는 것입니다. [SEP]\n[CLS] 황 CEO의 발언은 도널드 트럼프 대통령이 엔비디아의 최첨단 칩 중국 수출 금지를 계속 유지하겠다는 방침을 밝힌 직후 나왔습니다. [SEP]\n[CLS] 그러나 트럼프 대통령은 CBS 방송과 인터뷰에서 엔비디아의 최첨단 칩 중국 판매 허용 여부를 묻는 질문에 " 그렇게 하지 않을 것 " 이라며 " 최첨단 칩은 미국 외에는 누구도 갖지 못하게 하겠다 " 고 답한 바 있습니다. [SEP]\n[CLS] # 젠슨황 # 엔비디아 # 최고경영자 # CEO # 최첨단칩 # 중국 # 수출금지 # 미국 # 트럼프대통령 [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/366/0001120582?sid=104',
              title: '엔비디아 젠슨 황 “中, AI 경쟁에서 美 이길 것”',
              pubDate: 'Thu, 06 Nov 2025 08:02:00 +0900',
              trust_score: 0.7,
              description:
                '“서방 냉소주의가 AI 발전 가로막아”\n\n        세계 1위 반도체 기업 엔비디아 최고경영자(CEO) 젠슨 황이 5일(현지시각) 중국이 낮...',
              sentiment_description:
                '[CLS] 엔비디아 젠슨 황 “ 中, AI 경쟁에서 美 이길 것 ” [SEP]\n[CLS] 엔비디아는 현재 AI 칩 시장의 80 % 이상을 장악한 독점적 기업이다. [SEP]\n[CLS] 당초 트럼프 대통령은 엔비디아의 최신예 AI 칩 ‘ 블랙웰 ( Blackwell ) ’ 판매 문제를 시 주석과 논의할 수 있다고 시사했다. [SEP]\n[CLS] 하지만 주요 매체에 따르면 이번 회담에서 엔비디아 칩 문제는 끝내 논의되지 않은 것으로 알려졌다. [SEP]\n[CLS] 현재 엔비디아와 경쟁사 AMD는 중국 시장용으로 따로 제작한 저 ( 低 ) 성능 AI 칩 매출 15 % 를 미 정부에 지불하기로 합의한 상태다. [SEP]\n[CLS] 세계 1위 반도체 기업 엔비디아 최고경영자 ( CEO ) 젠슨 황이 5일 ( 현지시각 ) 중국이 낮은 에너지 비용과 유연한 규제를 바탕으로 AI 경쟁에서 미국과 유럽을 제칠 것이라고 밝혔다. [SEP]\n[CLS] 젠슨 황의 이번 작심 발언은 엔비디아가 처한 ‘ 정치 · 경제적 딜레마 ’ 를 고스란히 반영한다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/003/0013586116?sid=104',
              title:
                '[올댓차이나] 中, 국비 지원 데이터센터에 외국산 AI 칩 사용 금지',
              pubDate: 'Thu, 06 Nov 2025 17:17:00 +0900',
              trust_score: 0.7,
              description:
                '[서울=뉴시스]이재준 기자 = 중국 정부가 국가 자금 지원을 받는 신규 데이터센터에서 외국산 인공지능(AI) 칩 사용을 전면 금지했다고 홍콩경제...',
              sentiment_description:
                '[CLS] 외국산 AI 칩 금지로 엔비디아, AMD, 인텔 등 미국 반도체 기업들이 타격을 입을 전망이다. [SEP]\n[CLS] 조치는 미국 정부가 중국 수출을 제한하면서도 예외적으로 판매를 허용한 엔비디아의 H20 칩뿐 아니라 B200 · H200 등 고성능 AI 칩까지 적용된다. [SEP]\n[CLS] 가장 큰 피해가 예상되는 엔비디아의 젠슨 황 최고경영자 ( CEO ) 는 최근 인터뷰에서 “ 2022년 95 % 에 달하던 중국 내 AI 칩 시장 점유율이 현재는 사실상 0 % 수준으로 떨어졌다 ” 고 말했다. [SEP]\n[CLS] 앞서 중국 정부는 올해 들어 국가안보를 이유로 주요 IT 기업들에 엔비디아의 고급 AI 칩 구매 자제를 권고하고 국산 칩으로 대체하라고 유도했다. [SEP]',
            },
          ],
          sentiment_score: 0.03927118384705397,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'direct',
        },
        {
          source: '데이터센터',
          target: '엔비디아',
          weight: 0.9709605127573013,
          cooccurrence: 1.0,
          similarity: 0.9419210255146027,
          articles: [
            {
              link: 'https://n.news.naver.com/mnews/article/018/0006157654?sid=101',
              title: '中, 국가 지원 데이터센터 수입 AI칩 금지…엔비디아 타격',
              pubDate: 'Thu, 06 Nov 2025 15:16:00 +0900',
              trust_score: 0.7,
              description:
                '로이터, 복수 소식통 인용 보도\n"공정률 30% 미만 데이터센터에 명령"\n"엔비디아 中시장 복귀 무산시키는 결정타"[이데일리 김윤지 기자] 중국...',
              sentiment_description:
                '[CLS] 中, 국가 지원 데이터센터 수입 AI칩 금지 … 엔비디아 타격 [SEP]\n[CLS] " 엔비디아 中 시장 복귀 무산시키는 결정타 " [ 이데일리 김윤지 기자 ] 중국 정부가 국가지원을 받은 신규 데이터센터 프로젝트에 외국산 인공지능 ( AI ) 반도체 사용을 금지했다고 5일 ( 현지시간 ) 로이터통신이 복수의 소식통을 인용해 보도했다. [SEP]\n[CLS] 미국과 중국이 AI 주도권 경쟁을 벌이는 가운데 엔비디아의 최첨단 AI 칩 대중 수출 여부는 양국의 갈등 원인 중 하나였다. [SEP]\n[CLS] 도널드 트럼프 미국 대통령은 젠슨 황 엔비디아 최고경영자 ( CEO ) 의 끈질긴 로비에 한때 저성능 버전 블랙웰 ( 엔비디아 최첨단 AI 칩 시리즈 ) 의 대중 수출을 허용할 것을 시사했으나, 그는 이달 2일 CBS와 인터뷰에서 “ 중국이 엔비디아와 거래하는 것을 허용하겠지만 최첨단 기술을 사용하는 것은 허용하지 않을 것 ” 이라고 못 박았다. [SEP]\n[CLS] 이 시설은 민간 기술기업이 주도했지만 국가 지원을 받은 사업이었으며, 당초 엔비디아 칩을 도입할 계획으로 전해진다. [SEP]\n[CLS] 이번 중국 정부의 조치는 엔비디아의 중국 시장 복귀를 사실상 무산시키는 결정타가 될 수 있다고 로이터는 내다봤다. [SEP]\n[CLS] 이처럼 중국 국가지원 프로젝트에서 외국산 AI 칩이 배제되면 트럼프 행정부가 엔비디아의 최첨단 AI 칩 대중 수출을 허용하더라도 엔비디아의 중국 내 매출이 큰 타격을 입을 수 있기 때문이다. [SEP]\n[CLS] 미국 정부의 대중 수출 제한, 중국 정부의 자국산 반도체 사용 권고 등으로 엔비디아의 중국 내 AI칩 시장 점유율은 2022년 95 % 에서 현재 0 % 수준이다. [SEP]\n[CLS] 전문가들은 개발자들이 엔비디아의 소프트웨어 생태계 쿠다 ( CUDA ) 에 익숙해 자국산 대체재의 시장 침투율은 낮은 것으로 보고 있다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/009/0005586017?sid=101',
              title: '中 &quot;데이터센터에 외국산 AI칩 다 빼라&quot;',
              pubDate: 'Thu, 06 Nov 2025 17:57:00 +0900',
              trust_score: 0.7,
              description:
                '美규제 맞서 기술자립 박차\n화웨이 등 첨단칩 자급자족\n코로나 봉쇄때 기술 키웠듯\nAI 기술력 급속성장 가능성\n젠슨황 "전력 싸고 규제 유연\n중국...',
              sentiment_description:
                '[CLS] 이 칩은 엔비디아 시스템과 호환돼 데이터센터 전환이 용이하다는 장점도 있다. [SEP]\n[CLS] 앞서 미국은 엔비디아의 최고 사양 칩을 중국에 수출하는 것을 중단시킨 바 있다. [SEP]\n[CLS] 젠슨 황 엔비디아 최고경영자 ( CEO ) 도 중국의 \' AI굴기 \' 에 동의했다. [SEP]\n[CLS] 그는 지난달 " 엔비디아의 중국 시장 점유율이 95 % 에서 0 % 로 떨어졌다 " 고 전했다. [SEP]\n[CLS] 화웨이는 대형 AI 학습용 칩 \' 어센드 ( Ascend ) \' 시리즈로 엔비디아 최고급 GPU에 근접한 성능을 구현하며 자체 플랫폼을 구축하고 있다. [SEP]\n[CLS] 이를 두고 사우스차이나모닝포스트 ( SCMP ) 는 " 엔비디아 H20과 유사한 수준 " 이라고 보도했다. [SEP]\n[CLS] 또 캠브리콘 · 메타X 등 스타트업들이 엔비디아 대체 칩을 잇따라 출시하며 생태계가 빠르게 확대되고 있다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/277/0005675297?sid=104',
              title: '젠슨 황 &quot;中, AI 경쟁서 美 상대로 승리할 것&quot;',
              pubDate: 'Thu, 06 Nov 2025 09:03:00 +0900',
              trust_score: 0.7,
              description:
                '"서방, 냉소주의…전기 무료 中과 대조적젠슨 황 엔비디아 최고경영자(CEO)가 인공지능(AI) 경쟁에서 중국이 미국을 상대로 승리할 것이라고 경...',
              sentiment_description:
                '[CLS] 지방 정부들이 자국산 칩을 사용하면 엔비디아보다 에너지 효율이 떨어져 데이터센터 운영비 부담이 크다는 업계 불만을 접수한 뒤 인센티브를 확대했다. [SEP]\n[CLS] " 서방, 냉소주의 … 전기 무료 中 과 대조적젠슨 황 엔비디아 최고경영자 ( CEO ) 가 인공지능 ( AI ) 경쟁에서 중국이 미국을 상대로 승리할 것이라고 경고했다. [SEP]\n[CLS] 그는 중국 정부가 자국산 AI 칩을 사용할 수 있는 기업 친화적 환경을 조성한다며 엔비디아 AI 칩 대신 자국산 제품을 사용하는 기업에 에너지 보조금을 지급하는 정책을 예시로 들며 미국과 비교했다. [SEP]\n[CLS] 엔비디아 칩은 현재 연산 능력과 전력 효율성 등 측면에서 화웨이를 비롯한 중국산 칩보다 크게 앞서 있다는 평가를 받는다. [SEP]\n[CLS] 그러나 중국 정부가 에너지 보조금을 지급한다면 기업들이 중국산 칩을 사용하더라도 에너지 비용 부담이 줄어들기 때문에 엔비디아 칩을 사용할 유인이 사라진다는 설명이다. [SEP]\n[CLS] 지난 2일 방영된 CBS 방송과의 인터뷰에서 엔비디아의 최첨단 칩의 중국 판매를 허용하겠느냐는 질문에 " 최첨단 칩은 미국 외에는 누구도 갖지 못하게 하겠다 " 고 답했다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/366/0001120582?sid=104',
              title: '엔비디아 젠슨 황 “中, AI 경쟁에서 美 이길 것”',
              pubDate: 'Thu, 06 Nov 2025 08:02:00 +0900',
              trust_score: 0.7,
              description:
                '“서방 냉소주의가 AI 발전 가로막아”\n\n        세계 1위 반도체 기업 엔비디아 최고경영자(CEO) 젠슨 황이 5일(현지시각) 중국이 낮...',
              sentiment_description:
                '[CLS] 엔비디아 젠슨 황 “ 中, AI 경쟁에서 美 이길 것 ” [SEP]\n[CLS] 세계 1위 반도체 기업 엔비디아 최고경영자 ( CEO ) 젠슨 황이 5일 ( 현지시각 ) 중국이 낮은 에너지 비용과 유연한 규제를 바탕으로 AI 경쟁에서 미국과 유럽을 제칠 것이라고 밝혔다. [SEP]\n[CLS] 젠슨 황의 이번 작심 발언은 엔비디아가 처한 ‘ 정치 · 경제적 딜레마 ’ 를 고스란히 반영한다. [SEP]\n[CLS] 엔비디아는 현재 AI 칩 시장의 80 % 이상을 장악한 독점적 기업이다. [SEP]\n[CLS] 당초 트럼프 대통령은 엔비디아의 최신예 AI 칩 ‘ 블랙웰 ( Blackwell ) ’ 판매 문제를 시 주석과 논의할 수 있다고 시사했다. [SEP]\n[CLS] 하지만 주요 매체에 따르면 이번 회담에서 엔비디아 칩 문제는 끝내 논의되지 않은 것으로 알려졌다. [SEP]\n[CLS] 현재 엔비디아와 경쟁사 AMD는 중국 시장용으로 따로 제작한 저 ( 低 ) 성능 AI 칩 매출 15 % 를 미 정부에 지불하기로 합의한 상태다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/003/0013586116?sid=104',
              title:
                '[올댓차이나] 中, 국비 지원 데이터센터에 외국산 AI 칩 사용 금지',
              pubDate: 'Thu, 06 Nov 2025 17:17:00 +0900',
              trust_score: 0.7,
              description:
                '[서울=뉴시스]이재준 기자 = 중국 정부가 국가 자금 지원을 받는 신규 데이터센터에서 외국산 인공지능(AI) 칩 사용을 전면 금지했다고 홍콩경제...',
              sentiment_description:
                '[CLS] 외국산 AI 칩 금지로 엔비디아, AMD, 인텔 등 미국 반도체 기업들이 타격을 입을 전망이다. [SEP]\n[CLS] 조치는 미국 정부가 중국 수출을 제한하면서도 예외적으로 판매를 허용한 엔비디아의 H20 칩뿐 아니라 B200 · H200 등 고성능 AI 칩까지 적용된다. [SEP]\n[CLS] 가장 큰 피해가 예상되는 엔비디아의 젠슨 황 최고경영자 ( CEO ) 는 최근 인터뷰에서 “ 2022년 95 % 에 달하던 중국 내 AI 칩 시장 점유율이 현재는 사실상 0 % 수준으로 떨어졌다 ” 고 말했다. [SEP]\n[CLS] 앞서 중국 정부는 올해 들어 국가안보를 이유로 주요 IT 기업들에 엔비디아의 고급 AI 칩 구매 자제를 권고하고 국산 칩으로 대체하라고 유도했다. [SEP]',
            },
          ],
          sentiment_score: -0.14921979679382247,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'direct',
        },
        {
          source: '블랙웰',
          target: '엔비디아',
          weight: 0.9848338067531586,
          cooccurrence: 1.0,
          similarity: 0.9696676135063171,
          articles: [
            {
              link: 'https://n.news.naver.com/mnews/article/015/0005208009?sid=104',
              title:
                '트럼프가 블랙웰 수출 막았지만…젠슨 황 &quot;中, AI 경쟁서 美 앞설 것&quot;',
              pubDate: 'Thu, 06 Nov 2025 17:37:00 +0900',
              trust_score: 0.7,
              description:
                '"서방, 기술 냉소주의 빠져"…英 \'AI의 미래 서밋\'서 경고\n\n美 규제·수출 통제 콕찍어 비판\n"中기업, 보조금 받아 전기료 공짜\n중국칩, 성...',
              sentiment_description:
                '[CLS] 이 같은 젠슨 황 CEO의 발언은 도널드 트럼프 미국 대통령이 최근 시진핑 중국 국가주석과 정상회담을 한 이후 엔비디아의 첨단 ‘ 블랙웰 ’ 칩을 중국에 판매하지 않겠다고 밝힌 뒤 나왔다. [SEP]\n[CLS] AI · 제조업 결합땐 시너지 기대젠슨 황 엔비디아 최고경영자 ( CEO ) 가 “ 중국이 인공지능 ( AI ) 경쟁에서 미국을 앞설 것 ” 이라고 경고했다. [SEP]\n[CLS] 그러면서 “ ( 중국에서는 ) 전기가 무료 ” 라며 “ 중국이 기술 기업에 지급하는 에너지 보조금 때문에 현지 기술 기업이 엔비디아 AI 칩의 대체품을 훨씬 저렴하게 운용할 수 있다 ” 고 했다. [SEP]\n[CLS] 일반적으로 엔비디아의 고성능 AI 칩이 연산 능력과 전력 효율 면에서 중국산 칩보다 월등하다. [SEP]\n[CLS] 하지만 중국이 에너지 보조금을 지급한다면 기업들이 중국산 칩을 써도 에너지 비용이 줄어드는 만큼 엔비디아 칩의 장점이 사라진다는 것이다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/057/0001917359?sid=100',
              title:
                '김민석 총리 &quot;엔비디아 GPU 26만장 공급, 약속대로 진행&quot;',
              pubDate: 'Thu, 06 Nov 2025 16:14:00 +0900',
              trust_score: 0.7,
              description:
                '"블랙웰만 100% 공급 아닐수도"\n엔비디아가 한국 정부와 기업에 공급하기로 한 그래픽처리장치(CPU) 26만 장과 관련해 김민석 국무총리가 "...',
              sentiment_description:
                '[CLS] 김민석 총리 & quot ; 엔비디아 GPU 26만장 공급, 약속대로 진행 & quot ; [SEP]\n[CLS] # 김민석 # 엔비디아 # GPU # 블랙웰 # APEC # 젠슨황 [SEP]\n[CLS] 엔비디아가 한국 정부와 기업에 공급하기로 한 그래픽처리장치 ( CPU ) 26만 장과 관련해 김민석 국무총리가 " 결국은 다 민간에서 약속한 대로 진행이 될 것 " 이라고 말했습니다. [SEP]\n[CLS] 김 총리는 오늘 ( 6일 ) 오후 국회에서 열린 예산결산특별위원회 전체회에서 " 엔비디아가 26만 장의 칩을 한국에 공급하겠다고 했지만, 도널드 트럼프 미국 대통령이 \' 최신 칩은 미국 기업에만 제공하겠다 \' 고 말했는데 어느 말을 믿어야 하느냐 " 는 김대식 국민의힘 의원 질문에 이같이 답변했습니다. [SEP]\n[CLS] 이어 " 트럼프 대통령이 말한 다음 날에도 엔비디아에서 아랍에미리트 ( UAE ) 에 칩을 선적한 사례가 있다 " 고 설명했습니다. [SEP]\n[CLS] 앞서 엔비디아는 젠슨 황 최고경영자 ( CEO ) 의 지난달 31일 아시아경제협력체 ( APEC ) 에서 한국 정부와 삼성전자, SK그룹, 현대차그룹, 네이버클라우드 등에 26만 장의 GPU를 공급한다고 발표했습니다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/018/0006157130?sid=101',
              title: '“이러다 AI 경쟁서 중국이 미국 이길것”…젠슨황의 경고',
              pubDate: 'Thu, 06 Nov 2025 07:05:00 +0900',
              trust_score: 0.7,
              description:
                '젠슨 황, FT ‘AI 미래 서밋’서 발언\n“中, 에너지 비용 절감·규제완화 차별점”\n“AI 규제 마련하는 서방, 낙관주의 필요”[사진=이데일리...',
              sentiment_description:
                '[CLS] 그는 같은 날 기자들에게도 “ 엔비디아의 첨단 AI 칩인 블랙웰 칩은 다른 칩보다 10년은 앞서 있다 ” 면서 “ 이것을 다른 나라에 넘겨주지 않겠다 ” 고 말했다. [SEP]\n[CLS] 트럼프 대통령은 올해 8월 저성능 버전 블랙웰 ( 엔비디아의 최첨단 AI 칩 시리즈 ) 에 한해 중국 수출을 허용할 수 있다는 입장을 시사했다. [SEP]\n[CLS] “ AI 규제 마련하는 서방, 낙관주의 필요 ” [ 사진 = 이데일리 김태형 기자 ] [ 이데일리 김윤지 기자 ] 젠슨 황 엔비디아 최고경영자 ( CEO ) 가 5일 ( 현지시간 ) 에너지 비용 절감과 규제 완화로 인해 인공지능 ( AI ) 경쟁에서 중국이 미국을 이길 것이라고 경고했다. [SEP]\n[CLS] 그는 반면 중국의 경우 에너지 보조금 정책 덕분에 현지 기술기업들이 엔비디아 대체 AI 칩을 훨씬 저렴하게 운용할 수 있다면서 “ 중국에선 전기가 공짜나 다름없다 ” 고 말했다. [SEP]\n[CLS] FT는 그의 발언이 도널드 트럼프 대통령이 ” 엔비디아의 최첨단 AI 칩은 미국만 사용할 수 있다 “ 고 발언한 이후에 나왔다는 데 주목했다. [SEP]\n[CLS] 트럼프 대통령은 이달 2일 공개된 CBS 시사 프로그램 ‘ 60분 ’ 과의 인터뷰에서 “ 중국이 엔비디아와 거래하는 것을 허용하겠지만 최첨단 기술을 사용하는 것은 허용하지 않을 것 ” 면서 “ 최첨단 기술은 미국 외에는 누구도 사용하지 못하게 할 것 ” 이라고 못 박았다. [SEP]\n[CLS] 월스트리트저널 ( WSJ ) 에 따르면 트럼프 대통령은 황 CEO의 끈질긴 로비에 한때 지난달 30일 열린 미중 정상회담에서 엔비디아 첨단 AI의 대중 수출 문제를 의제에 포함시킬 계획이었다. [SEP]\n[CLS] 엔비디아와 AMD는 올해 8월 트럼프 행정부와 대중국 판매액 중 15 % 를 제공 받는 계약도 체결했다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/031/0000978447?sid=105',
              title:
                '젠슨 황 엔비디아 &quot;중국이 AI 경쟁에서 미국 이길 것&quot;',
              pubDate: 'Thu, 06 Nov 2025 09:53:00 +0900',
              trust_score: 0.7,
              description:
                '트럼프 "엔비디아 칩, 중국에 수출 금지" 발언 이후 나와\n황 CEO, 미국 냉소주의 지적⋯"더 많은 낙관주의 필요"세계 1위 인공지능(AI)...',
              sentiment_description:
                '[CLS] 젠슨 황 엔비디아 & quot ; 중국이 AI 경쟁에서 미국 이길 것 & quot ; [SEP]\n[CLS] 하지만 트럼프 대통령은 시 주석과의 회담 이후 " 엔비디아의 최첨단 블랙웰 ( Blackwell ) 칩을 중국이 쓰도록 놔두지 않겠다 " 고 말했다. [SEP]\n[CLS] 트럼프 " 엔비디아 칩, 중국에 수출 금지 " 발언 이후 나와 [SEP]\n[CLS] 황 CEO, 미국 냉소주의 [UNK] " 더 많은 낙관주의 필요 " 세계 1위 인공지능 ( AI ) 칩 생산기업인 젠슨 황 엔비디아 최고경영자 ( CEO ) 가 AI 경쟁에서 중국이 미국에 이길 것이라고 경고했다. [SEP]\n[CLS] 황 CEO의 발언은 도널드 트럼프 미국 대통령이 지난주 시진핑 중국 국가주석과의 회담 이후에도, 캘리포니아에 본사를 둔 엔비디아가 자사의 최첨단 칩을 베이징에 판매하는 것을 금지하는 조치를 유지한 것에 이어 나왔다. [SEP]\n[CLS] 또 " ( 중국에서는 ) 전기가 무료 " 라며 중국이 기술 기업에 주는 에너지 보조금 때문에 현지 기술 기업이 엔비디아 AI 칩의 대체품을 더 저렴하게 운용할 수 있을 거라고 지적했다. [SEP]\n[CLS] 또 중국 내 지방 정부들은 화웨이, 캠브리콘 같은 국산 반도체의 에너지 효율이 엔비디아 제품보다 낮아 비용이 높다는 기술 기업들의 불만 이후, 전력 인센티브를 강화했다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/001/0015724398?sid=104',
              title:
                "백악관 &quot;大法, '관세재판'서 옳은 판결할것…플랜B는 항상 준비&quot;(종합)",
              pubDate: 'Wed, 05 Nov 2025 05:07:00 +0900',
              trust_score: 0.6467511599000726,
              description:
                '"대통령은 관세 사용 비상권한 반드시 갖고 있어야"\n"엔비디아 최신 AI 반도체 블랙웰, 현재로선 中에 팔 생각 없어"\n\n(워싱턴=연합뉴스) 이...',
              sentiment_description:
                '[CLS] " 엔비디아 최신 AI 반도체 블랙웰, 현재로선 中 에 팔 생각 없어 " [SEP]\n[CLS] 한편, 레빗 대변인은 미국 기업 엔비디아의 최첨단 인공지능 ( AI ) 반도체인 블랙웰을 중국에 판매하지 않을 것이라는 트럼프 대통령의 입장을 재확인했다. [SEP]',
            },
          ],
          sentiment_score: 0.3438170521908078,
          sentiment_label: 'positive',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'direct',
        },
        {
          source: '엔비디아',
          target: '캠브리콘',
          weight: 0.9768619388341904,
          cooccurrence: 1.0,
          similarity: 0.9537238776683807,
          articles: [
            {
              link: 'https://n.news.naver.com/mnews/article/003/0013586093?sid=104',
              title: '‘중국판 엔비디아’ 캠브리콘 주가 또 마오타이 추월',
              pubDate: 'Thu, 06 Nov 2025 17:09:00 +0900',
              trust_score: 0.7,
              description:
                '외국 AI칩 퇴출설에 급등…AI 훈풍에 선두 복귀[서울=뉴시스] 문예성 기자 = 중국 인공지능(AI) 관련 종목들이 강세를 이어가는 가운데, ‘...',
              sentiment_description:
                '[CLS] ‘ 중국판 엔비디아 ’ 캠브리콘 주가 또 마오타이 추월 [SEP]\n[CLS] 외국 AI칩 퇴출설에 급등 … AI 훈풍에 선두 복귀 [ 서울 = 뉴시스 ] 문예성 기자 = 중국 인공지능 ( AI ) 관련 종목들이 강세를 이어가는 가운데, ‘ 중국판 엔비디아 ’ 로 불리는 AI 반도체 설계업체 캠브리콘 ( 한우지 ) 이 6일 또다시 귀주마오타이를 제치며 중국 증시 시가총액 1위 자리를 탈환했다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/366/0001120706?sid=105',
              title:
                '中, 정부 데이터센터서 ‘외국산 AI 칩’ 전면 퇴출령… 기술 독립 초강...',
              pubDate: 'Thu, 06 Nov 2025 13:19:00 +0900',
              trust_score: 0.7,
              description:
                '국가 자금 투입 데이터센터에 중국산 칩만 허용\n화웨이·캠브리콘 등 토종 칩 부상\n“中 AI 칩 자급률 80% 목표 앞당겨질 듯”...',
              sentiment_description:
                '[CLS] 한 소식통은 엔비디아 그래픽처리장치 ( GPU ) 를 사용할 예정이었던 중국 북서부 지방의 민간 데이터센터를 비롯한 일부 프로젝트가 이번 지침으로 전면 중단됐다고 전했다. [SEP]\n[CLS] 앞서 도널드 트럼프 미국 대통령은 지난달 30일 시진핑 중국 국가주석과의 정상회담 이후 CBS 인터뷰에서 “ 중국이 엔비디아와 거래하는 것은 허용하겠지만, 가장 진보된 칩은 아닐 것 ” 이라고 말했다. [SEP]\n[CLS] 그러나 중국 정부는 엔비디아의 중국용 저사양 AI 칩인 H20까지도 국가 데이터센터에 사용하지 못하도록 하고 있는 것으로 알려졌다. [SEP]\n[CLS] 이를 두고 한 업계 관계자는 “ 미국이 중국으로 AI 칩 판매를 재개하더라도, 엔비디아와 AMD, 인텔 등의 AI 칩을 국책 사업에서 배제하면 중국 시장 재진입이 쉽지 않을 것 ” 이라고 말했다. [SEP]\n[CLS] 엔비디아의 중국 AI 칩 시장 점유율은 2022년 95 % 에서 현재 0 % 로 떨어졌다. [SEP]\n[CLS] 젠슨 황 엔비디아 최고경영자 ( CEO ) 는 그간 “ 중국이 미국산 칩에 일정 부분 의존하게 두는 것이 오히려 미국에 전략적으로 이익이 된다 ” 며 미 정부에 AI 칩 판매 재개를 설득해 왔지만, 오히려 중국은 기술 독립에 무게를 두고 있는 것이다. [SEP]\n[CLS] 엔비디아가 밀려난 자리는 화웨이를 비롯한 중국 토종 기업들이 빠르게 꿰찰 전망이다. [SEP]\n[CLS] 특히 화웨이는 자체 AI 칩 ‘ 어센드 ’ 를 중심으로 국유기업과 공공기관 납품을 확대하고 있으며, 엔비디아 GPU에서 훈련된 AI 모델을 어센드 칩에서도 구동할 수 있도록 호환 소프트웨어를 무료로 제공하고 있다. [SEP]\n[CLS] 반도체 시장조사업체 세미애널리시스의 딜런 파텔 수석 연구원은 “ 지난해 중국 시장에서 엔비디아 H20이 약 100만개, 화웨이 어센드910B는 50만개가 판매됐는데, 올해 들어 그 격차가 급속히 좁혀지고 있다 ” 고 분석했다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/138/0002208921?sid=105',
              title:
                "GPU 제국 엔비디아, AI시대 '중앙은행'…韓 AI 주권 지킬 '방패' 어디에",
              pubDate: 'Thu, 06 Nov 2025 15:48:00 +0900',
              trust_score: 0.7,
              description:
                '[인더AI] AI 권력의 피라미드…주권의 무게를 묻다\n\n[디지털데일리 김문기 기자] 26만 장의 GPU를 들여올 예정인 우리나라는 엔비디아라는...',
              sentiment_description:
                "[CLS] GPU 제국 엔비디아, AI시대 ' 중앙은행 ' … 韓 AI 주권 지킬 ' 방패 ' 어디에 [SEP]\n[CLS] 미국과 유럽은 엔비디아 협력 없이는 초대형 모델을 학습시키지 못하고 중국은 수출 통제에 맞서 어센드 ( Ascend ) 와 캠브리콘 ( Cambricon ) 을 내세워 독자 칩을 지원하고 있다. [SEP]\n[CLS] [ 디지털데일리 김문기 기자 ] 26만 장의 GPU를 들여올 예정인 우리나라는 엔비디아라는 거대한 생태계에 편입될 가능성이 커졌다. [SEP]\n[CLS] 한때 그래픽 카드로 출발했던 엔비디아는 불과 10년 만에 인공지능 시대의 질서를 설계하는 대표적 기업으로 성장했다. [SEP]\n[CLS] 그 화폐를 찍어내고 유통량을 조절하는 마치 중앙은행의 역할을 하는 곳이 바로 엔비디아라 볼 수 있다. [SEP]\n[CLS] 엔비디아의 힘은 단순한 칩의 성능에서 나오지 않는다. [SEP]\n[CLS] 젠슨 황 엔비디아 CEO는 GPU를 그래픽 연산기에서 범용 병렬처리기로 재정의했고, 그 위에 CUDA라는 언어를 세웠다. [SEP]\n[CLS] 6일 업계 전문가는 이에 대해 \" 기준에 따라 다르게 읽힐 수는 있으나 결과적으로 엔비디아의 흐름을 막을 수 없기 때문에 기술 종속화는 일종의 딜레마일수밖에 없다 \" 라며 \" 국가적으로도 그간 세워놓은 계획들을 다시 정비할 수 있어야 하며 전력과 AI 인력, 생태계 측면에서 만반의 준비가 필요하다 \" 고 말했다. [SEP]\n[CLS] [UNK] AI 중앙은행 ' 엔비디아 ' [SEP]\n[CLS] 이 과정에서 엔비디아는 하드웨어를 팔고 소프트웨어를 묶었으며, 드라이버와 프레임워크, 클라우드 서비스까지 한 줄로 이어 붙였다. [SEP]\n[CLS] AI 개발자가 코드를 올리고 모델을 학습할 때, 데이터센터가 돌아갈 때, 그 이익은 다시 엔비디아로 돌아간다고 해석할 수도 있다. [SEP]\n[CLS] 이를 두고 영국 이코노미스트는 ' AI의 새로운 경제에서 엔비디아는 연산 화폐를 주조하고 중앙은행처럼 그 유통량을 조절한다 ' 고 표현했다. [SEP]\n[CLS] 지난 3월 파이낸셜타임스의 경우에는 ' 엔비디아의 영향력은 유동성을 조절하는 중앙은행과 같다 ' 는 동일 해석을 내놨다. [SEP]\n[CLS] 엔비디아가 칩 제조사가 아니라 금융기관처럼 산업의 속도를 조절하고 있다는 뜻이었다. [SEP]\n[CLS] TSMC는 엔비디아 전용 4나노 공정을 배정했고 삼성전자는 HBM3E 메모리를 블랙웰 아키텍처에 맞춰 공급한다. [SEP]\n[CLS] 네덜란드의 ASML, 일본의 포토레지스트, 미국의 서버 제조사까지 엔비디아의 로드맵에 맞춰 움직이고 있다. [SEP]\n[CLS] GPU는 물리적 장비이자 연산의 통화이며 그 유동량을 조절하는 존재가 엔비디아라고 볼 수 있다. [SEP]\n[CLS] 일본은 정부 예산으로 엔비디아 클러스터를 구축하며 AI 경쟁의 속도를 맞추려 안간힘을 쓰고 있다. [SEP]\n[CLS] 정부와 대기업이 동시에 엔비디아 생태계에 올라탔고, 2024년 이후 대부분의 AI 클러스터가 H100과 GH200, 블랙웰로 전환됐다. [SEP]\n[CLS] 삼성은 ‘ 엔비디아 인증 데이터센터 ’ 를 도입했고, SK텔레콤은 엔비디아와 손잡고 ‘ AI 팩토리 코리아 ’ 를 추진했다. [SEP]\n[CLS] 국가 예산이 투입된 AI 컴퓨팅센터조차 엔비디아 드라이버와 툴체인에 전적으로 의존하고 있다. [SEP]\n[CLS] GPU의 교체 주기와 가격, 업데이트 일정까지 모두 엔비디아의 로드맵에 맞춰 돌아간다. [SEP]\n[CLS] 한국은 세계에서 가장 빠르게 엔비디아 생태계에 편입된 나라이고, 그만큼 리스크도 먼저 체감할 나라다. [SEP]\n[CLS] 문제는 공장의 주인이 엔비디아라는데 있다. [SEP]\n[CLS] 엔비디아는 AI 인프라의 중앙은행이고 GPU는 그들이 발행한 연산 통화다. [SEP]\n[CLS] 엔비디아 중심 구조의 본질은 ‘ 지배 ’ 가 아니라 ‘ 표준 ’ 이다. [SEP]\n[CLS] 엔비디아의 CUDA가 폐쇄형이라면, 우리는 오히려 공개형 생태계를 키워야 할 수도 있다. [SEP]\n[CLS] 엔비디아에 전적으로 최적화된 구조에서 벗어나, GPU · NPU · ASIC을 혼합해 운영하는 멀티 아키텍처 데이터센터를 구축해야 한다. [SEP]\n[CLS] 엔비디아의 생태계 안에서 성장한 만큼, 이제는 그 경계를 넘을 준비를 해야 한다. [SEP]",
            },
            {
              link: 'https://n.news.naver.com/mnews/article/031/0000978447?sid=105',
              title:
                '젠슨 황 엔비디아 &quot;중국이 AI 경쟁에서 미국 이길 것&quot;',
              pubDate: 'Thu, 06 Nov 2025 09:53:00 +0900',
              trust_score: 0.7,
              description:
                '트럼프 "엔비디아 칩, 중국에 수출 금지" 발언 이후 나와\n황 CEO, 미국 냉소주의 지적⋯"더 많은 낙관주의 필요"세계 1위 인공지능(AI)...',
              sentiment_description:
                '[CLS] 젠슨 황 엔비디아 & quot ; 중국이 AI 경쟁에서 미국 이길 것 & quot ; [SEP]\n[CLS] 또 중국 내 지방 정부들은 화웨이, 캠브리콘 같은 국산 반도체의 에너지 효율이 엔비디아 제품보다 낮아 비용이 높다는 기술 기업들의 불만 이후, 전력 인센티브를 강화했다. [SEP]\n[CLS] 트럼프 " 엔비디아 칩, 중국에 수출 금지 " 발언 이후 나와 [SEP]\n[CLS] 황 CEO, 미국 냉소주의 [UNK] " 더 많은 낙관주의 필요 " 세계 1위 인공지능 ( AI ) 칩 생산기업인 젠슨 황 엔비디아 최고경영자 ( CEO ) 가 AI 경쟁에서 중국이 미국에 이길 것이라고 경고했다. [SEP]\n[CLS] 황 CEO의 발언은 도널드 트럼프 미국 대통령이 지난주 시진핑 중국 국가주석과의 회담 이후에도, 캘리포니아에 본사를 둔 엔비디아가 자사의 최첨단 칩을 베이징에 판매하는 것을 금지하는 조치를 유지한 것에 이어 나왔다. [SEP]\n[CLS] 또 " ( 중국에서는 ) 전기가 무료 " 라며 중국이 기술 기업에 주는 에너지 보조금 때문에 현지 기술 기업이 엔비디아 AI 칩의 대체품을 더 저렴하게 운용할 수 있을 거라고 지적했다. [SEP]\n[CLS] 하지만 트럼프 대통령은 시 주석과의 회담 이후 " 엔비디아의 최첨단 블랙웰 ( Blackwell ) 칩을 중국이 쓰도록 놔두지 않겠다 " 고 말했다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/023/0003938897?sid=105',
              title: '中, “화웨이 칩 쓰면 전기료 반값”...엔비디아 견제',
              pubDate: 'Tue, 04 Nov 2025 17:42:00 +0900',
              trust_score: 0.6005909172301145,
              description:
                '중국이 자국 반도체를 사용하는 데이터센터의 전기 요금을 절반까지 감면해주는 제도를 도입했다. 중국은 엔비디아 반도체 의존도를 줄이기 위해 자국...',
              sentiment_description:
                '[CLS] 中, “ 화웨이 칩 쓰면 전기료 반값 ”... 엔비디아 견제 [SEP]\n[CLS] 중국은 엔비디아 반도체 의존도를 줄이기 위해 자국 인공지능 ( AI ) 반도체 사용을 장려하고 있다. [SEP]\n[CLS] 중국은 지난 9월 바이트댄스와 알리바바 등 중국 빅테크 기업에 엔비디아 칩 구매를 금지시켰다. [SEP]\n[CLS] 하지만 중국산 AI 칩의 전력 효율이 엔비디아 칩에 비해 크게 떨어지면서, 빅테크들의 전력 비용이 늘어났다. [SEP]\n[CLS] FT는 “ 중국산 칩에서 같은 양의 토큰을 생성하는 데 필요한 전력은 엔비디아 H20 ( 중국용 칩 ) 보다 30 ~ 50 % 가량 높다 ” 며 “ 여러 테크 기업이 운영비가 급증했다고 당국에 불만을 제기하자 새 보조금이 나왔다 ” 고 했다. [SEP]\n[CLS] 엔비디아 등 해외 업체의 칩을 사용하는 데이터센터는 이 보조금을 받을 수 없다. [SEP]\n[CLS] FT는 “ 중국이 자국 테크 기업의 엔비디아 의존도를 줄이고 자국 반도체 산업을 육성해 미국과의 AI 경쟁에 맞서려는 움직임 ” 이라고 했다. [SEP]',
            },
          ],
          sentiment_score: 0.21513905965363395,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'direct',
        },
        {
          source: '엔비디아',
          target: '정의선',
          weight: 0.9423203468322754,
          cooccurrence: 1.0,
          similarity: 0.8846406936645508,
          articles: [
            {
              link: 'https://n.news.naver.com/mnews/article/016/0002553435?sid=101',
              title:
                '“고맙다 깐부” 국민연금, 엔비디아 ‘덕’ 쏠쏠…美 주식투자로 3개월...',
              pubDate: 'Thu, 06 Nov 2025 07:36:00 +0900',
              trust_score: 0.7,
              description:
                '美주식 552개 종목 186조원 보유…3개월새 평가액 11.2% 증가\n엔비디아서 가장 큰 수익…애플·테슬라 등 대부분 종목서 보유주식 늘려\n\n젠...',
              sentiment_description:
                '[CLS] “ 고맙다 깐부 ” 국민연금, 엔비디아 ‘ 덕 ’ 쏠쏠 … 美 주식투자로 3개월... [SEP]\n[CLS] 젠슨 황 엔비디아 최고경영자와 이재용 삼성전자 회장, 정의선 현대차그룹 회장이 지난달 30일 서울 코엑스에서 열린 엔비디아의 그래픽카드 ( GPU ) ‘ 지포스 ’ 출시 25주년 행사에 참석해 있다. [SEP]\n[CLS] 엔비디아서 가장 큰 수익 … 애플 · 테슬라 등 대부분 종목서 보유주식 늘려 [SEP]\n[CLS] 특히 가장 큰 수익을 안겨준 종목은 엔비디아로 나타났다. [SEP]\n[CLS] 눈에 띄는 수익률의 일등공신은 엔비디아로, 평가액이 가장 큰 폭으로 증가한 것으로 나타났다. [SEP]\n[CLS] 국민연금의 미국주식 포트폴리오 비중 1위는 엔비디아 ( 7. 2 % ), 이어 애플 ( 5. 9 % ), 마이크로소프트 ( 5. 7 % ), 아마존닷컴 ( 3. 2 % ), 메타플랫폼 ( 2. 5 % ) 순이었다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/145/0000022618?sid=103',
              title: '젠슨황·이재용·정의선···AI치맥 회동 치킨 세트 나왔다',
              pubDate: 'Thu, 06 Nov 2025 08:16:00 +0900',
              trust_score: 0.7,
              description:
                '삼성 이재용·현대차 정의선·엔비디아 젠슨황의 ‘AI 동맹 치맥 회동’이 치킨 세트로 출시됐다.\n\n깐부치킨은 젠슨 황 엔비디아 CEO, 이재용 삼...',
              sentiment_description:
                '[CLS] 삼성 이재용 · 현대차 정의선 · 엔비디아 젠슨황의 ‘ AI 동맹 치맥 회동 ’ 이 치킨 세트로 출시됐다. [SEP]\n[CLS] 깐부치킨은 젠슨 황 엔비디아 CEO, 이재용 삼성전자 회장, 정의선 현대차그룹 회장이 함께한 비공식 치맥 회동 메뉴를 그대로 재현한 ‘ AI깐부 세트 ’ 를 출시했다고 밝혔다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/243/0000087530?sid=101',
              title:
                "&quot;그날의 치맥 그대로!&quot; 깐부치킨, 젠슨 황·이재용·정의선 회동 메뉴 '...",
              pubDate: 'Wed, 05 Nov 2025 10:20:00 +0900',
              trust_score: 0.6467511599000726,
              description:
                "수익금 10% 기부까지[이코노미스트 우승민 기자] 삼성·현대차·엔비디아의 'AI 동맹 치맥 회동'이 치킨 세트로 부활했다.\n\n깐부치킨이 젠슨 황...",
              sentiment_description:
                "[CLS] 깐부치킨이 젠슨 황 엔비디아 CEO, 이재용 삼성전자 회장, 정의선 현대차그룹 회장이 함께한 비공식 치맥 회동 메뉴를 그대로 재현한 ' AI깐부 세트 ' 를 출시하며 관심을 모으고 있다. [SEP]\n[CLS] 수익금 10 % 기부까지 [ 이코노미스트 우승민 기자 ] 삼성 · 현대차 · 엔비디아의 ' AI 동맹 치맥 회동 ' 이 치킨 세트로 부활했다. [SEP]",
            },
            {
              link: 'https://n.news.naver.com/mnews/article/032/0003406651?sid=101',
              title:
                '젠슨 황·이재용·정의선 ‘깐부’ 셋이 먹은 메뉴 ‘AI 세트’로 나왔...',
              pubDate: 'Tue, 04 Nov 2025 21:06:00 +0900',
              trust_score: 0.6467511599000726,
              description:
                "‘바삭한 식스팩’ ‘크리스피 순살’ ‘치즈스틱’···'AI깐부' 메뉴 출시\n삼성역 치킨 매장 손님 몰려 자리 경쟁에 “1시간만 이용 가능”\n젠슨...",
              sentiment_description:
                '[CLS] 젠슨 황 엔비디아 최고경영자 ( CEO ) 와 이재용 삼성전자 회장, 정의선 현대차그룹 회장이 ‘ 치맥 ( 치킨 + 맥주 ) 회동 ’ 을 했던 깐부치킨 매장에 인파가 몰리면서 세 사람이 앉았던 테이블에 이용시간 제한까지 걸렸다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/015/0005206995?sid=103',
              title: "'젠슨황·이재용·정의선' 회장님 입맛 그대로…메뉴 내놨더니",
              pubDate: 'Tue, 04 Nov 2025 19:01:00 +0900',
              trust_score: 0.6005909172301145,
              description:
                "깐부치킨 ‘AI깐부’ 출시\n빙그레도 젠슨 황 효과 '톡톡'…바나나우유 마케팅\n젠슨 황 엔비디아 최고경영자(CEO)와 이재용 삼성전자 회장, 정의...",
              sentiment_description:
                '[CLS] 젠슨 황 엔비디아 최고경영자 ( CEO ) 와 이재용 삼성전자 회장, 정의선 현대자동차그룹 회장이 모인 ‘ 세기의 치맥 회동 ’ 으로 홍보 효과를 톡톡히 본 깐부치킨이 당시 세 총수가 먹었던 조합을 그대로 정식 메뉴화해 선보였다. [SEP]',
            },
          ],
          sentiment_score: 0.27877627851182857,
          sentiment_label: 'positive',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'direct',
        },
        {
          source: '이재용',
          target: '한국',
          weight: 0.4220433831214905,
          cooccurrence: 0.0,
          similarity: 0.844086766242981,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '이재용',
          target: '중국',
          weight: 0.3769519627094269,
          cooccurrence: 0.0,
          similarity: 0.7539039254188538,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '이재용',
          target: '칩',
          weight: 0.372382752597332,
          cooccurrence: 0.0,
          similarity: 0.744765505194664,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '데이터센터',
          target: '이재용',
          weight: 0.35749225318431854,
          cooccurrence: 0.0,
          similarity: 0.7149845063686371,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '블랙웰',
          target: '이재용',
          weight: 0.40675102174282074,
          cooccurrence: 0.0,
          similarity: 0.8135020434856415,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '이재용',
          target: '캠브리콘',
          weight: 0.3767313212156296,
          cooccurrence: 0.0,
          similarity: 0.7534626424312592,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '이재용',
          target: '정의선',
          weight: 0.6771675765514373,
          cooccurrence: 0.4,
          similarity: 0.9543351531028748,
          articles: [
            {
              link: 'https://n.news.naver.com/mnews/article/016/0002553435?sid=101',
              title:
                '“고맙다 깐부” 국민연금, 엔비디아 ‘덕’ 쏠쏠…美 주식투자로 3개월...',
              pubDate: 'Thu, 06 Nov 2025 07:36:00 +0900',
              trust_score: 0.7,
              description:
                '美주식 552개 종목 186조원 보유…3개월새 평가액 11.2% 증가\n엔비디아서 가장 큰 수익…애플·테슬라 등 대부분 종목서 보유주식 늘려\n\n젠...',
              sentiment_description:
                '[CLS] “ 고맙다 깐부 ” 국민연금, 엔비디아 ‘ 덕 ’ 쏠쏠 … 美 주식투자로 3개월... 젠슨 황 엔비디아 최고경영자와 이재용 삼성전자 회장, 정의선 현대차그룹 회장이 지난달 30일 서울 코엑스에서 열린 엔비디아의 그래픽카드 ( GPU ) ‘ 지포스 ’ 출시 25주년 행사에 참석해 있다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/243/0000087530?sid=101',
              title:
                "&quot;그날의 치맥 그대로!&quot; 깐부치킨, 젠슨 황·이재용·정의선 회동 메뉴 '...",
              pubDate: 'Wed, 05 Nov 2025 10:20:00 +0900',
              trust_score: 0.6467511599000726,
              description:
                "수익금 10% 기부까지[이코노미스트 우승민 기자] 삼성·현대차·엔비디아의 'AI 동맹 치맥 회동'이 치킨 세트로 부활했다.\n\n깐부치킨이 젠슨 황...",
              sentiment_description:
                "[CLS] & quot ; 그날의 치맥 그대로! & quot ; 깐부치킨, 젠슨 황 · 이재용 · 정의선 회동 메뉴 '... 깐부치킨이 젠슨 황 엔비디아 CEO, 이재용 삼성전자 회장, 정의선 현대차그룹 회장이 함께한 비공식 치맥 회동 메뉴를 그대로 재현한 ' AI깐부 세트 ' 를 출시하며 관심을 모으고 있다. 앞서 황 CEO는 지난달 30일 서울 강남구 삼성동 인근 한 깐부치킨 매장에서 이재용 회장, 정의선 회장과 비공식 회동을 가졌다. [SEP]",
            },
          ],
          sentiment_score: 0.27829972747394605,
          sentiment_label: 'positive',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '중국',
          target: '한국',
          weight: 0.36257025599479675,
          cooccurrence: 0.0,
          similarity: 0.7251405119895935,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '칩',
          target: '한국',
          weight: 0.36819902807474136,
          cooccurrence: 0.0,
          similarity: 0.7363980561494827,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '데이터센터',
          target: '한국',
          weight: 0.37140482664108276,
          cooccurrence: 0.0,
          similarity: 0.7428096532821655,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '블랙웰',
          target: '한국',
          weight: 0.5195380508899688,
          cooccurrence: 0.2,
          similarity: 0.8390761017799377,
          articles: [
            {
              link: 'https://n.news.naver.com/mnews/article/057/0001917359?sid=100',
              title:
                '김민석 총리 &quot;엔비디아 GPU 26만장 공급, 약속대로 진행&quot;',
              pubDate: 'Thu, 06 Nov 2025 16:14:00 +0900',
              trust_score: 0.7,
              description:
                '"블랙웰만 100% 공급 아닐수도"\n엔비디아가 한국 정부와 기업에 공급하기로 한 그래픽처리장치(CPU) 26만 장과 관련해 김민석 국무총리가 "...',
              sentiment_description:
                '[CLS] 김민석 총리 & quot ; 엔비디아 GPU 26만장 공급, 약속대로 진행 & quot ; " 블랙웰만 100 % 공급 아닐수도 " 다만 " 공급받기로 한 GPU가 다 ( 최신 칩인 ) 블랙웰만으로 100 % 되는 것은 아니라고 볼 수도 있다 " 고 덧붙였습니다. # 김민석 # 엔비디아 # GPU # 블랙웰 # APEC # 젠슨황 엔비디아가 한국 정부와 기업에 공급하기로 한 그래픽처리장치 ( CPU ) 26만 장과 관련해 김민석 국무총리가 " 결국은 다 민간에서 약속한 대로 진행이 될 것 " 이라고 말했습니다. 김 총리는 오늘 ( 6일 ) 오후 국회에서 열린 예산결산특별위원회 전체회에서 " 엔비디아가 26만 장의 칩을 한국에 공급하겠다고 했지만, 도널드 트럼프 미국 대통령이 \' 최신 칩은 미국 기업에만 제공하겠다 \' 고 말했는데 어느 말을 믿어야 하느냐 " 는 김대식 국민의힘 의원 질문에 이같이 답변했습니다. 앞서 엔비디아는 젠슨 황 최고경영자 ( CEO ) 의 지난달 31일 아시아경제협력체 ( APEC ) 에서 한국 정부와 삼성전자, SK그룹, 현대차그룹, 네이버클라우드 등에 26만 장의 GPU를 공급한다고 발표했습니다. [SEP]',
            },
          ],
          sentiment_score: 0.47703220494557286,
          sentiment_label: 'positive',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '캠브리콘',
          target: '한국',
          weight: 0.396772637963295,
          cooccurrence: 0.0,
          similarity: 0.79354527592659,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '정의선',
          target: '한국',
          weight: 0.40663839876651764,
          cooccurrence: 0.0,
          similarity: 0.8132767975330353,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '중국',
          target: '칩',
          weight: 0.7946312755346299,
          cooccurrence: 0.6,
          similarity: 0.9892625510692596,
          articles: [
            {
              link: 'https://n.news.naver.com/mnews/article/001/0015726856?sid=104',
              title:
                '첨단칩 중국 판매금지에…젠슨황 &quot;중국, AI 경쟁서 미국 제칠것&quot;',
              pubDate: 'Thu, 06 Nov 2025 07:57:00 +0900',
              trust_score: 0.7,
              description:
                '"서방, 기술 냉소주의에 빠져…전기 무료로 쓰는 중국과 대조적"\n\n    (샌프란시스코=연합뉴스) 권영전 특파원 = 세계 1위 인공지능(AI)...',
              sentiment_description:
                '[CLS] 첨단칩 중국 판매금지에 … 젠슨황 & quot ; 중국, AI 경쟁서 미국 제칠것 & quot ; ( 샌프란시스코 = 연합뉴스 ) 권영전 특파원 = 세계 1위 인공지능 ( AI ) 칩 생산기업 엔비디아의 젠슨 황 최고경영자 ( CEO ) 가 AI 경쟁에서 중국이 미국에 승리할 것이라고 경고했다. 그러면서 그는 " ( 중국에서는 ) 전기가 무료 " 라며 중국이 기술 기업들에 지급하는 에너지 보조금 때문에 현지 기술기업이 엔비디아 AI 칩의 대체품을 훨씬 저렴하게 운용할 수 있다고 지적했다. 일반적으로 엔비디아 고성능 칩이 연산 능력과 전력 효율성 면에서 화웨이 등 중국산 칩을 압도하는 것으로 평가된다. 하지만 중국이 에너지 보조금을 지급한다면 기업들이 화웨이 칩을 쓰면서도 에너지 비용을 많이 부담하지 않게 되면서 엔비디아 칩의 장점이 일정 부분 상쇄된다는 것이다. 황 CEO의 이와 같은 발언은 도널드 트럼프 대통령이 엔비디아의 최첨단 칩의 중국 수출금지를 계속 고수하겠다는 방침을 밝힌 이후 나온 것이다. 그러나 트럼프 대통령은 CBS 방송과 인터뷰에서 엔비디아의 최첨단 칩의 중국 판매를 허락하겠느냐는 질문에 " 그렇게 하지 않을 것 " 이라며 " 최첨단 칩은 미국 외에는 누구도 갖지 못하게 하겠다 " 고 답했다. " 서방, 기술 냉소주의에 빠져 … 전기 무료로 쓰는 중국과 대조적 " 실제로 중국이 최근 바이트댄스, 알리바바, 텐센트 등 주요 기술기업에 에너지 보조금을 증액했다는 보도가 나온 바 있다. 황 CEO는 지난달 말 미국 워싱턴DC에서 개최한 개발자행사 ( GTC ) 에서 " 미국이 ( 중국과의 ) AI 경쟁에서 승리하기를 바란다 " 면서 그러기 위해서는 중국 시장에 진출해야 한다고 강조했다. 중국에 반도체를 판매해 중국이 미국의 기술에 의존하도록 하는 것이 미국에 AI 승리를 가져다준다는 논리였다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/366/0001120582?sid=104',
              title: '엔비디아 젠슨 황 “中, AI 경쟁에서 美 이길 것”',
              pubDate: 'Thu, 06 Nov 2025 08:02:00 +0900',
              trust_score: 0.7,
              description:
                '“서방 냉소주의가 AI 발전 가로막아”\n\n        세계 1위 반도체 기업 엔비디아 최고경영자(CEO) 젠슨 황이 5일(현지시각) 중국이 낮...',
              sentiment_description:
                '[CLS] 엔비디아 젠슨 황 “ 中, AI 경쟁에서 美 이길 것 ” 현재 엔비디아와 경쟁사 AMD는 중국 시장용으로 따로 제작한 저 ( 低 ) 성능 AI 칩 매출 15 % 를 미 정부에 지불하기로 합의한 상태다. 세계 1위 반도체 기업 엔비디아 최고경영자 ( CEO ) 젠슨 황이 5일 ( 현지시각 ) 중국이 낮은 에너지 비용과 유연한 규제를 바탕으로 AI 경쟁에서 미국과 유럽을 제칠 것이라고 밝혔다. 미 · 중 기술 패권 경쟁의 향방을 쥔 핵심 인물이 ‘ 중국의 AI 승리 ’ 를 공언하면서, 실리콘밸리와 워싱턴 정계에 상당한 파장이 일 것으로 예상된다. 젠슨 황은 5일 영국 런던에서 파이낸셜타임스 ( FT ) 가 주최한 ‘ AI의 미래 서밋 ’ 에서 “ 중국이 AI 레이스에서 승리할 것 ( China is going to win the AI race ) ” 이라고 했다. 젠슨 황은 중국이 파격적인 비용 절감과 신속하고 효율적인 규제라는 두 가지 카드로 AI 산업에 몰두하고 있다고 분석했다. FT에 따르면 젠슨 황은 거대 AI 모델을 훈련하고 운영하는 데이터센터를 언급하며 “ 중국이 ( 서방보다 ) 훨씬 낮은 에너지 비용을 무기로 삼고 있다 ” 고 했다. 그러나 가장 큰 시장인 중국 진출길이 트럼프 행정부가 주도하는 고강도 수출 규제로 사실상 막혀있다. 이번 발언은 도널드 트럼프 미국 대통령과 시진핑 중국 주석이 정상회담을 가진 직후에 나왔다. 엔비디아는 현재 AI 칩 시장의 80 % 이상을 장악한 독점적 기업이다. 당초 트럼프 대통령은 엔비디아의 최신예 AI 칩 ‘ 블랙웰 ( Blackwell ) ’ 판매 문제를 시 주석과 논의할 수 있다고 시사했다. 하지만 주요 매체에 따르면 이번 회담에서 엔비디아 칩 문제는 끝내 논의되지 않은 것으로 알려졌다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/277/0005675297?sid=104',
              title: '젠슨 황 &quot;中, AI 경쟁서 美 상대로 승리할 것&quot;',
              pubDate: 'Thu, 06 Nov 2025 09:03:00 +0900',
              trust_score: 0.7,
              description:
                '"서방, 냉소주의…전기 무료 中과 대조적젠슨 황 엔비디아 최고경영자(CEO)가 인공지능(AI) 경쟁에서 중국이 미국을 상대로 승리할 것이라고 경...',
              sentiment_description:
                '[CLS] 젠슨 황 & quot ; 中, AI 경쟁서 美 상대로 승리할 것 & quot ; 그는 중국 정부가 자국산 AI 칩을 사용할 수 있는 기업 친화적 환경을 조성한다며 엔비디아 AI 칩 대신 자국산 제품을 사용하는 기업에 에너지 보조금을 지급하는 정책을 예시로 들며 미국과 비교했다. 엔비디아 칩은 현재 연산 능력과 전력 효율성 등 측면에서 화웨이를 비롯한 중국산 칩보다 크게 앞서 있다는 평가를 받는다. 그러나 중국 정부가 에너지 보조금을 지급한다면 기업들이 중국산 칩을 사용하더라도 에너지 비용 부담이 줄어들기 때문에 엔비디아 칩을 사용할 유인이 사라진다는 설명이다. 황 CEO는 이전에도 미국의 최신 AI 모델이 중국 경쟁사보다 크게 앞서 있지 않다고 경고하며 미국 정부가 나머지 세계가 미국 기술에 의존하도록 하기 위해 칩 시장을 개방해야 한다고 촉구한 바 있다. 지난 2일 방영된 CBS 방송과의 인터뷰에서 엔비디아의 최첨단 칩의 중국 판매를 허용하겠느냐는 질문에 " 최첨단 칩은 미국 외에는 누구도 갖지 못하게 하겠다 " 고 답했다. " 서방, 냉소주의 … 전기 무료 中 과 대조적젠슨 황 엔비디아 최고경영자 ( CEO ) 가 인공지능 ( AI ) 경쟁에서 중국이 미국을 상대로 승리할 것이라고 경고했다. 황 CEO는 이러한 전망의 근거로 미국과 중국의 기술 규제를 언급했다. 황 CEO는 " ( 중국에서는 ) 전기가 무료 " 라고 강조했다. FT는 최근 중국이 바이트댄스, 알리바바, 텐센트 등 주요 기술 기업이 운영하는 데이터 센터에 전력 요금을 최대 50 % 까지 인하하는 보조금 제도를 도입했다고 보도했다. 지방 정부들이 자국산 칩을 사용하면 엔비디아보다 에너지 효율이 떨어져 데이터센터 운영비 부담이 크다는 업계 불만을 접수한 뒤 인센티브를 확대했다. [SEP]',
            },
          ],
          sentiment_score: -0.19583493692698137,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '데이터센터',
          target: '중국',
          weight: 0.6770662784576416,
          cooccurrence: 0.4,
          similarity: 0.9541325569152832,
          articles: [
            {
              link: 'https://n.news.naver.com/mnews/article/277/0005675297?sid=104',
              title: '젠슨 황 &quot;中, AI 경쟁서 美 상대로 승리할 것&quot;',
              pubDate: 'Thu, 06 Nov 2025 09:03:00 +0900',
              trust_score: 0.7,
              description:
                '"서방, 냉소주의…전기 무료 中과 대조적젠슨 황 엔비디아 최고경영자(CEO)가 인공지능(AI) 경쟁에서 중국이 미국을 상대로 승리할 것이라고 경...',
              sentiment_description:
                '[CLS] 젠슨 황 & quot ; 中, AI 경쟁서 美 상대로 승리할 것 & quot ; 지방 정부들이 자국산 칩을 사용하면 엔비디아보다 에너지 효율이 떨어져 데이터센터 운영비 부담이 크다는 업계 불만을 접수한 뒤 인센티브를 확대했다. " 서방, 냉소주의 … 전기 무료 中 과 대조적젠슨 황 엔비디아 최고경영자 ( CEO ) 가 인공지능 ( AI ) 경쟁에서 중국이 미국을 상대로 승리할 것이라고 경고했다. 황 CEO는 이러한 전망의 근거로 미국과 중국의 기술 규제를 언급했다. 그는 중국 정부가 자국산 AI 칩을 사용할 수 있는 기업 친화적 환경을 조성한다며 엔비디아 AI 칩 대신 자국산 제품을 사용하는 기업에 에너지 보조금을 지급하는 정책을 예시로 들며 미국과 비교했다. 황 CEO는 " ( 중국에서는 ) 전기가 무료 " 라고 강조했다. 엔비디아 칩은 현재 연산 능력과 전력 효율성 등 측면에서 화웨이를 비롯한 중국산 칩보다 크게 앞서 있다는 평가를 받는다. 그러나 중국 정부가 에너지 보조금을 지급한다면 기업들이 중국산 칩을 사용하더라도 에너지 비용 부담이 줄어들기 때문에 엔비디아 칩을 사용할 유인이 사라진다는 설명이다. FT는 최근 중국이 바이트댄스, 알리바바, 텐센트 등 주요 기술 기업이 운영하는 데이터 센터에 전력 요금을 최대 50 % 까지 인하하는 보조금 제도를 도입했다고 보도했다. 황 CEO는 이전에도 미국의 최신 AI 모델이 중국 경쟁사보다 크게 앞서 있지 않다고 경고하며 미국 정부가 나머지 세계가 미국 기술에 의존하도록 하기 위해 칩 시장을 개방해야 한다고 촉구한 바 있다. 지난 2일 방영된 CBS 방송과의 인터뷰에서 엔비디아의 최첨단 칩의 중국 판매를 허용하겠느냐는 질문에 " 최첨단 칩은 미국 외에는 누구도 갖지 못하게 하겠다 " 고 답했다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/366/0001120582?sid=104',
              title: '엔비디아 젠슨 황 “中, AI 경쟁에서 美 이길 것”',
              pubDate: 'Thu, 06 Nov 2025 08:02:00 +0900',
              trust_score: 0.7,
              description:
                '“서방 냉소주의가 AI 발전 가로막아”\n\n        세계 1위 반도체 기업 엔비디아 최고경영자(CEO) 젠슨 황이 5일(현지시각) 중국이 낮...',
              sentiment_description:
                '[CLS] 엔비디아 젠슨 황 “ 中, AI 경쟁에서 美 이길 것 ” FT에 따르면 젠슨 황은 거대 AI 모델을 훈련하고 운영하는 데이터센터를 언급하며 “ 중국이 ( 서방보다 ) 훨씬 낮은 에너지 비용을 무기로 삼고 있다 ” 고 했다. 세계 1위 반도체 기업 엔비디아 최고경영자 ( CEO ) 젠슨 황이 5일 ( 현지시각 ) 중국이 낮은 에너지 비용과 유연한 규제를 바탕으로 AI 경쟁에서 미국과 유럽을 제칠 것이라고 밝혔다. 미 · 중 기술 패권 경쟁의 향방을 쥔 핵심 인물이 ‘ 중국의 AI 승리 ’ 를 공언하면서, 실리콘밸리와 워싱턴 정계에 상당한 파장이 일 것으로 예상된다. 젠슨 황은 5일 영국 런던에서 파이낸셜타임스 ( FT ) 가 주최한 ‘ AI의 미래 서밋 ’ 에서 “ 중국이 AI 레이스에서 승리할 것 ( China is going to win the AI race ) ” 이라고 했다. 젠슨 황은 중국이 파격적인 비용 절감과 신속하고 효율적인 규제라는 두 가지 카드로 AI 산업에 몰두하고 있다고 분석했다. 그러나 가장 큰 시장인 중국 진출길이 트럼프 행정부가 주도하는 고강도 수출 규제로 사실상 막혀있다. 이번 발언은 도널드 트럼프 미국 대통령과 시진핑 중국 주석이 정상회담을 가진 직후에 나왔다. 현재 엔비디아와 경쟁사 AMD는 중국 시장용으로 따로 제작한 저 ( 低 ) 성능 AI 칩 매출 15 % 를 미 정부에 지불하기로 합의한 상태다. [SEP]',
            },
          ],
          sentiment_score: 0.05365409366153381,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '블랙웰',
          target: '중국',
          weight: 0.5752116054296493,
          cooccurrence: 0.2,
          similarity: 0.9504232108592987,
          articles: [
            {
              link: 'https://n.news.naver.com/mnews/article/031/0000978447?sid=105',
              title:
                '젠슨 황 엔비디아 &quot;중국이 AI 경쟁에서 미국 이길 것&quot;',
              pubDate: 'Thu, 06 Nov 2025 09:53:00 +0900',
              trust_score: 0.7,
              description:
                '트럼프 "엔비디아 칩, 중국에 수출 금지" 발언 이후 나와\n황 CEO, 미국 냉소주의 지적⋯"더 많은 낙관주의 필요"세계 1위 인공지능(AI)...',
              sentiment_description:
                '[CLS] 젠슨 황 엔비디아 & quot ; 중국이 AI 경쟁에서 미국 이길 것 & quot ; 하지만 트럼프 대통령은 시 주석과의 회담 이후 " 엔비디아의 최첨단 블랙웰 ( Blackwell ) 칩을 중국이 쓰도록 놔두지 않겠다 " 고 말했다. 트럼프 " 엔비디아 칩, 중국에 수출 금지 " 발언 이후 나와 황 CEO, 미국 냉소주의 [UNK] " 더 많은 낙관주의 필요 " 세계 1위 인공지능 ( AI ) 칩 생산기업인 젠슨 황 엔비디아 최고경영자 ( CEO ) 가 AI 경쟁에서 중국이 미국에 이길 것이라고 경고했다. 황 CEO의 발언은 도널드 트럼프 미국 대통령이 지난주 시진핑 중국 국가주석과의 회담 이후에도, 캘리포니아에 본사를 둔 엔비디아가 자사의 최첨단 칩을 베이징에 판매하는 것을 금지하는 조치를 유지한 것에 이어 나왔다. 또 " ( 중국에서는 ) 전기가 무료 " 라며 중국이 기술 기업에 주는 에너지 보조금 때문에 현지 기술 기업이 엔비디아 AI 칩의 대체품을 더 저렴하게 운용할 수 있을 거라고 지적했다. 중국은 최근 바이트댄스, 알리바바, 텐센트 등 주요 기술 기업에 에너지 보조금을 증액했다. 또 중국 내 지방 정부들은 화웨이, 캠브리콘 같은 국산 반도체의 에너지 효율이 엔비디아 제품보다 낮아 비용이 높다는 기술 기업들의 불만 이후, 전력 인센티브를 강화했다. 황 CEO는 과거에도 미국의 최신 AI 모델이 중국 경쟁사보다 크게 앞서 있지 않다며, 세계가 미국 기술에 의존할 수 있도록 시장 개방이 필요하다고 주장해 왔다. 황 CEO는 지난달 미국 워싱턴 D. C에서 열린 개발자 행사 ( GTC ) 에서 " 미국이 ( 중국과의 ) AI 경쟁에서 이기길 바란다 " 며 그러기 위해서는 중국 시장에 진출해야 한다고 강조했다. [SEP]',
            },
          ],
          sentiment_score: 0.046026601416602385,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '중국',
          target: '캠브리콘',
          weight: 0.5630707055330276,
          cooccurrence: 0.2,
          similarity: 0.9261414110660553,
          articles: [
            {
              link: 'https://n.news.naver.com/mnews/article/031/0000978447?sid=105',
              title:
                '젠슨 황 엔비디아 &quot;중국이 AI 경쟁에서 미국 이길 것&quot;',
              pubDate: 'Thu, 06 Nov 2025 09:53:00 +0900',
              trust_score: 0.7,
              description:
                '트럼프 "엔비디아 칩, 중국에 수출 금지" 발언 이후 나와\n황 CEO, 미국 냉소주의 지적⋯"더 많은 낙관주의 필요"세계 1위 인공지능(AI)...',
              sentiment_description:
                '[CLS] 젠슨 황 엔비디아 & quot ; 중국이 AI 경쟁에서 미국 이길 것 & quot ; 또 중국 내 지방 정부들은 화웨이, 캠브리콘 같은 국산 반도체의 에너지 효율이 엔비디아 제품보다 낮아 비용이 높다는 기술 기업들의 불만 이후, 전력 인센티브를 강화했다. 트럼프 " 엔비디아 칩, 중국에 수출 금지 " 발언 이후 나와 황 CEO, 미국 냉소주의 [UNK] " 더 많은 낙관주의 필요 " 세계 1위 인공지능 ( AI ) 칩 생산기업인 젠슨 황 엔비디아 최고경영자 ( CEO ) 가 AI 경쟁에서 중국이 미국에 이길 것이라고 경고했다. 황 CEO의 발언은 도널드 트럼프 미국 대통령이 지난주 시진핑 중국 국가주석과의 회담 이후에도, 캘리포니아에 본사를 둔 엔비디아가 자사의 최첨단 칩을 베이징에 판매하는 것을 금지하는 조치를 유지한 것에 이어 나왔다. 또 " ( 중국에서는 ) 전기가 무료 " 라며 중국이 기술 기업에 주는 에너지 보조금 때문에 현지 기술 기업이 엔비디아 AI 칩의 대체품을 더 저렴하게 운용할 수 있을 거라고 지적했다. 중국은 최근 바이트댄스, 알리바바, 텐센트 등 주요 기술 기업에 에너지 보조금을 증액했다. 황 CEO는 과거에도 미국의 최신 AI 모델이 중국 경쟁사보다 크게 앞서 있지 않다며, 세계가 미국 기술에 의존할 수 있도록 시장 개방이 필요하다고 주장해 왔다. 하지만 트럼프 대통령은 시 주석과의 회담 이후 " 엔비디아의 최첨단 블랙웰 ( Blackwell ) 칩을 중국이 쓰도록 놔두지 않겠다 " 고 말했다. 황 CEO는 지난달 미국 워싱턴 D. C에서 열린 개발자 행사 ( GTC ) 에서 " 미국이 ( 중국과의 ) AI 경쟁에서 이기길 바란다 " 며 그러기 위해서는 중국 시장에 진출해야 한다고 강조했다. [SEP]',
            },
          ],
          sentiment_score: 0.14655495773338237,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '정의선',
          target: '중국',
          weight: 0.38392430543899536,
          cooccurrence: 0.0,
          similarity: 0.7678486108779907,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '데이터센터',
          target: '칩',
          weight: 0.7877348840236664,
          cooccurrence: 0.6,
          similarity: 0.9754697680473328,
          articles: [
            {
              link: 'https://n.news.naver.com/mnews/article/277/0005675297?sid=104',
              title: '젠슨 황 &quot;中, AI 경쟁서 美 상대로 승리할 것&quot;',
              pubDate: 'Thu, 06 Nov 2025 09:03:00 +0900',
              trust_score: 0.7,
              description:
                '"서방, 냉소주의…전기 무료 中과 대조적젠슨 황 엔비디아 최고경영자(CEO)가 인공지능(AI) 경쟁에서 중국이 미국을 상대로 승리할 것이라고 경...',
              sentiment_description:
                '[CLS] 젠슨 황 & quot ; 中, AI 경쟁서 美 상대로 승리할 것 & quot ; 지방 정부들이 자국산 칩을 사용하면 엔비디아보다 에너지 효율이 떨어져 데이터센터 운영비 부담이 크다는 업계 불만을 접수한 뒤 인센티브를 확대했다. 그는 중국 정부가 자국산 AI 칩을 사용할 수 있는 기업 친화적 환경을 조성한다며 엔비디아 AI 칩 대신 자국산 제품을 사용하는 기업에 에너지 보조금을 지급하는 정책을 예시로 들며 미국과 비교했다. 엔비디아 칩은 현재 연산 능력과 전력 효율성 등 측면에서 화웨이를 비롯한 중국산 칩보다 크게 앞서 있다는 평가를 받는다. 그러나 중국 정부가 에너지 보조금을 지급한다면 기업들이 중국산 칩을 사용하더라도 에너지 비용 부담이 줄어들기 때문에 엔비디아 칩을 사용할 유인이 사라진다는 설명이다. 황 CEO는 이전에도 미국의 최신 AI 모델이 중국 경쟁사보다 크게 앞서 있지 않다고 경고하며 미국 정부가 나머지 세계가 미국 기술에 의존하도록 하기 위해 칩 시장을 개방해야 한다고 촉구한 바 있다. 지난 2일 방영된 CBS 방송과의 인터뷰에서 엔비디아의 최첨단 칩의 중국 판매를 허용하겠느냐는 질문에 " 최첨단 칩은 미국 외에는 누구도 갖지 못하게 하겠다 " 고 답했다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/366/0001120582?sid=104',
              title: '엔비디아 젠슨 황 “中, AI 경쟁에서 美 이길 것”',
              pubDate: 'Thu, 06 Nov 2025 08:02:00 +0900',
              trust_score: 0.7,
              description:
                '“서방 냉소주의가 AI 발전 가로막아”\n\n        세계 1위 반도체 기업 엔비디아 최고경영자(CEO) 젠슨 황이 5일(현지시각) 중국이 낮...',
              sentiment_description:
                '[CLS] 엔비디아 젠슨 황 “ 中, AI 경쟁에서 美 이길 것 ” FT에 따르면 젠슨 황은 거대 AI 모델을 훈련하고 운영하는 데이터센터를 언급하며 “ 중국이 ( 서방보다 ) 훨씬 낮은 에너지 비용을 무기로 삼고 있다 ” 고 했다. 엔비디아는 현재 AI 칩 시장의 80 % 이상을 장악한 독점적 기업이다. 당초 트럼프 대통령은 엔비디아의 최신예 AI 칩 ‘ 블랙웰 ( Blackwell ) ’ 판매 문제를 시 주석과 논의할 수 있다고 시사했다. 하지만 주요 매체에 따르면 이번 회담에서 엔비디아 칩 문제는 끝내 논의되지 않은 것으로 알려졌다. 현재 엔비디아와 경쟁사 AMD는 중국 시장용으로 따로 제작한 저 ( 低 ) 성능 AI 칩 매출 15 % 를 미 정부에 지불하기로 합의한 상태다. [SEP]',
            },
            {
              link: 'https://n.news.naver.com/mnews/article/003/0013586116?sid=104',
              title:
                '[올댓차이나] 中, 국비 지원 데이터센터에 외국산 AI 칩 사용 금지',
              pubDate: 'Thu, 06 Nov 2025 17:17:00 +0900',
              trust_score: 0.7,
              description:
                '[서울=뉴시스]이재준 기자 = 중국 정부가 국가 자금 지원을 받는 신규 데이터센터에서 외국산 인공지능(AI) 칩 사용을 전면 금지했다고 홍콩경제...',
              sentiment_description:
                '[CLS] [ 올댓차이나 ] 中, 국비 지원 데이터센터에 외국산 AI 칩 사용 금지 [ 서울 = 뉴시스 ] 이재준 기자 = 중국 정부가 국가 자금 지원을 받는 신규 데이터센터에서 외국산 인공지능 ( AI ) 칩 사용을 전면 금지했다고 홍콩경제일보와 거형망, 동망 ( 東 網 ) 등이 6일 보도했다. 중국 당국은 최근 몇 주 사이에 건설 진척률이 30 % 미만인 데이터센터에 대해 이미 설치한 외국산 AI 칩을 전부 철거하거나 관련 구매 계획을 취소할 것을 명령했다. 데이터센터의 상당수가 직 · 간접적으로 정부 재정지원을 받는 만큼 외국산 AI 칩 금지의 경제적 파급력은 엄청나다. 공정이 많이 진전된 데이터센터 프로젝트 경우에는 당국이 개별 심사를 통해 예외 여부를 판단할 방침이라고 한다.. 중국 정부 입찰 자료로는 2021년 이후 중국에서 진행한 AI 데이터센터 프로젝트에는 총 1000억 달러 ( 약 144조8600원 ) 이상 공공자금이 투입됐다. 매체는 복수의 관계자 소식통과 외신을 인용해 이같이 전하며 외국산 대신 중국산 칩 사용을 의무화하는 지침을 내려졌다고 밝혔다. 외국산 AI 칩 금지로 엔비디아, AMD, 인텔 등 미국 반도체 기업들이 타격을 입을 전망이다. 반대로 화웨이 ( 華 [UNK] 技 術 ), 한우지 ( 寒 武 紀 Cambricon ), 메타엑스 ( MetaX ), 모어스레드 ( Moore Threads ), 쑤이위안 ( [UNK] 原 · Enflame ) 등 중국 AI 칩 제조사에는 새로운 공급 기회를 잡게 됐다. 조치는 미국 정부가 중국 수출을 제한하면서도 예외적으로 판매를 허용한 엔비디아의 H20 칩뿐 아니라 B200 · H200 등 고성능 AI 칩까지 적용된다. 가장 큰 피해가 예상되는 엔비디아의 젠슨 황 최고경영자 ( CEO ) 는 최근 인터뷰에서 “ 2022년 95 % 에 달하던 중국 내 AI 칩 시장 점유율이 현재는 사실상 0 % 수준으로 떨어졌다 ” 고 말했다. 앞서 중국 정부는 올해 들어 국가안보를 이유로 주요 IT 기업들에 엔비디아의 고급 AI 칩 구매 자제를 권고하고 국산 칩으로 대체하라고 유도했다. 지침은 미국이 첨단 AI 칩의 대중 수출을 제한한 데 대한 대응 성격도 있다는 분석이다. [SEP]',
            },
          ],
          sentiment_score: -0.1063795341730932,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '블랙웰',
          target: '칩',
          weight: 0.47385840117931366,
          cooccurrence: 0.0,
          similarity: 0.9477168023586273,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '칩',
          target: '캠브리콘',
          weight: 0.4745277166366577,
          cooccurrence: 0.0,
          similarity: 0.9490554332733154,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '정의선',
          target: '칩',
          weight: 0.382559597492218,
          cooccurrence: 0.0,
          similarity: 0.765119194984436,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '데이터센터',
          target: '블랙웰',
          weight: 0.46350163221359253,
          cooccurrence: 0.0,
          similarity: 0.9270032644271851,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '데이터센터',
          target: '캠브리콘',
          weight: 0.4821959435939789,
          cooccurrence: 0.0,
          similarity: 0.9643918871879578,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '데이터센터',
          target: '정의선',
          weight: 0.3692116066813469,
          cooccurrence: 0.0,
          similarity: 0.7384232133626938,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '블랙웰',
          target: '캠브리콘',
          weight: 0.5574008882045746,
          cooccurrence: 0.2,
          similarity: 0.9148017764091492,
          articles: [
            {
              link: 'https://n.news.naver.com/mnews/article/031/0000978447?sid=105',
              title:
                '젠슨 황 엔비디아 &quot;중국이 AI 경쟁에서 미국 이길 것&quot;',
              pubDate: 'Thu, 06 Nov 2025 09:53:00 +0900',
              trust_score: 0.7,
              description:
                '트럼프 "엔비디아 칩, 중국에 수출 금지" 발언 이후 나와\n황 CEO, 미국 냉소주의 지적⋯"더 많은 낙관주의 필요"세계 1위 인공지능(AI)...',
              sentiment_description:
                '[CLS] 젠슨 황 엔비디아 & quot ; 중국이 AI 경쟁에서 미국 이길 것 & quot ; 하지만 트럼프 대통령은 시 주석과의 회담 이후 " 엔비디아의 최첨단 블랙웰 ( Blackwell ) 칩을 중국이 쓰도록 놔두지 않겠다 " 고 말했다. 또 중국 내 지방 정부들은 화웨이, 캠브리콘 같은 국산 반도체의 에너지 효율이 엔비디아 제품보다 낮아 비용이 높다는 기술 기업들의 불만 이후, 전력 인센티브를 강화했다. [SEP]',
            },
          ],
          sentiment_score: 0.000651308340320541,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '블랙웰',
          target: '정의선',
          weight: 0.41067394614219666,
          cooccurrence: 0.0,
          similarity: 0.8213478922843933,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
        {
          source: '정의선',
          target: '캠브리콘',
          weight: 0.38517865538597107,
          cooccurrence: 0.0,
          similarity: 0.7703573107719421,
          articles: [],
          sentiment_score: 0.0,
          sentiment_label: 'neutral',
          sentiment_subject: '엔비디아',
          sentiment_derivation: 'propagated',
          hops_to_main: 1,
        },
      ],
      metadata: {
        total_nodes: 9,
        total_edges: 36,
      },
    };
  }

  /**
   * 더미 에이전트 결과를 받아 DB에 저장
   * - Node: upsert(복합 유니크 userID+name)
   * - Edge: upsert(복합 유니크 userID+startPoint+endPoint)
   * - News: createMany(중복 허용)
   */
  public async saveGraphForUser(
    dto: CollectNewsDTO,
    userID: string,
  ): Promise<IngestSummary> {
    const uid = (userID ?? '').trim();
    if (!uid) throw new BadRequestException('userID is required');

    const res = await this.dummyAgentCall();

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

    if (uid === 'admin7145') {
      // 내부 더미
      res = await this.dummyAgentCall_second();
    } else {
      // 1) 키워드로 뉴스 수집
      const newsResult = await this.crawlNewsByKeywords(dto);

      // 2) 뉴스 결과를 Body로 원격 API에 POST  (래퍼 제거)
      const url =
        'https://wing-ai-production.up.railway.app/process?mode=normal';

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
    }

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
}
