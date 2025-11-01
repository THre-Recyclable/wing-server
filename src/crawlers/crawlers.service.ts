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
      nodePairs.set(name, n.importance ?? 0);
    }

    type EdgeKey = string; // `${src}→${dst}`
    const edgePairs = new Map<EdgeKey, number>();
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

      edgePairs.set(`${source}→${target}`, e.weight ?? 0);

      for (const a of e.articles ?? []) {
        newsRows.push({
          userID: uid,
          startPoint: source,
          endPoint: target,
          pubDate: a.pubDate ?? '',
          link: a.link ?? '',
          title: a.title ?? '',
          description: a.description ?? '',
        });
      }
    }

    // 2) 트랜잭션
    await this.prisma.$transaction(async (tx) => {
      // 2-1) Node upsert
      for (const [name, weight] of nodePairs.entries()) {
        await tx.node.upsert({
          where: {
            // 복합 유니크 입력명은 Prisma가 자동 생성합니다.
            // 보통 Node_userID_name_key 또는 userID_name 로 잡힙니다.
            userID_name: { userID: uid, name }, // ← 스키마 기준 자동 생성된 입력명
          },
          create: { userID: uid, name, weight },
          update: { weight },
        });
      }

      // 2-2) Edge upsert
      for (const [key, weight] of edgePairs.entries()) {
        const [startPoint, endPoint] = key.split('→');
        await tx.edge.upsert({
          where: {
            userID_startPoint_endPoint: { userID: uid, startPoint, endPoint },
          },
          create: { userID: uid, startPoint, endPoint, weight },
          update: { weight },
        });
      }

      // 2-3) News 다건 삽입 (중복 허용)
      if (newsRows.length > 0) {
        // 너무 많으면 청크로 나눠 안전하게
        const CHUNK = 500;
        for (let i = 0; i < newsRows.length; i += CHUNK) {
          const slice = newsRows.slice(i, i + CHUNK);
          await tx.news.createMany({ data: slice });
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
