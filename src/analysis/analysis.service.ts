// src/analysis/analysis.service.ts
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AlphaVantageService } from 'src/alpha-vantage/alpha-vantage.service';
import { FinnhubService } from 'src/finnhub/finnhub.service';
import dayjs from 'dayjs';
import { PrismaService } from 'src/prisma.service';
import OpenAI from 'openai';

@Injectable()
export class AnalysisService {
  constructor(
    private readonly alpha: AlphaVantageService,
    private readonly finnhub: FinnhubService,
    private readonly prisma: PrismaService,
    private readonly openai: OpenAI,
  ) {}

  async resolveGraphSymbol(user: string, graphId: number) {
    const userId = (user ?? '').trim();
    if (!userId) {
      throw new BadRequestException('user id is required');
    }
    if (!graphId || graphId <= 0) {
      throw new BadRequestException('graphId is required');
    }

    // 1) 그래프 존재 여부 확인
    const graph = await this.prisma.graph.findFirst({
      where: { id: graphId, userID: userId },
    });
    if (!graph) {
      throw new NotFoundException('graph not found for this user');
    }

    // 2) 해당 그래프의 노드들 조회
    const nodes = await this.prisma.node.findMany({
      where: { userID: userId, graphId },
      orderBy: [
        { kind: 'asc' }, // MAIN 먼저, SUB 나중 (enum 순서에 따라)
        { weight: 'desc' },
      ],
    });

    if (!nodes.length) {
      throw new BadRequestException('graph has no nodes');
    }

    // 3) 메인 키워드 / 전체 키워드 정리
    const mainNode = nodes.find((n: any) => n.kind === 'MAIN') ?? nodes[0];
    const mainKeyword = (mainNode.name ?? '').trim();

    const allKeywords = Array.from(
      new Set(
        nodes
          .map((n: any) => (n.name ?? '').trim())
          .filter((name) => name.length > 0),
      ),
    );

    if (!mainKeyword) {
      throw new BadRequestException('main keyword is empty');
    }

    // 4) OpenAI에 넘길 페이로드 구성
    const payload = {
      main_keyword: mainKeyword,
      all_keywords: allKeywords,
      instructions: [
        '1. 먼저 main_keyword가 특정 상장 기업(주식 종목명)을 직접 가리키는지 판단하라.',
        '2. 그렇다면 해당 기업의 주식 티커(symbol)를 chosen_symbol에 넣어라. (예: "엔비디아" -> "NVDA", "테슬라" -> "TSLA", "삼성전자" -> "005930" 등)',
        '3. main_keyword가 AI, 반도체, 전기차 같은 테마/산업이면, all_keywords 전체를 보고 가장 관련성이 높은 상장 기업 하나를 고르고 그 티커를 chosen_symbol에 넣어라.',
        '4. 미국/글로벌에 상장된, 널리 알려진 티커를 우선적으로 선택하되, 한국 기업이 명확하면 한국 증시 종목코드를 사용할 수 있다.',
        '5. 한국 증시에 상장된 종목이면 is_domestic를 true, 그 외(미국/유럽 등 해외 상장 주식)면 false로 설정하라.',
        '6. 반드시 JSON 형식으로만 답하라. 예: { "chosen_symbol": "NVDA", "is_domestic": false }',
      ],
    };

    // 5) OpenAI 호출
    const completion = await this.openai.chat.completions.create({
      model: 'gpt-5.1',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are a stock symbol resolver. You receive Korean or English keywords and must output the single most relevant stock ticker symbol (e.g. NVDA, TSLA, 005930). Always respond with strict JSON including "chosen_symbol" and a boolean "is_domestic" which is true only if the symbol represents a stock listed on the Korean stock market (KRX, KOSPI, KOSDAQ).',
        },
        {
          role: 'user',
          content: JSON.stringify(payload),
        },
      ],
    });

    const content = completion.choices[0]?.message?.content ?? '{}';

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new InternalServerErrorException(
        'Failed to parse OpenAI response as JSON',
      );
    }

    // 원본 심볼 (suffix 포함일 수도 있음)
    const rawSymbol: string = (parsed.chosen_symbol ?? parsed.symbol ?? '')
      .toString()
      .trim();

    if (!rawSymbol) {
      throw new InternalServerErrorException(
        'OpenAI did not return a stock symbol',
      );
    }

    // KRX 관련 suffix 제거 (.KS, .KQ, .KRX, .KOSPI, .KOSDAQ 등)
    const krxSuffixRegex = /\.(KS|KQ|KRX|KOSPI|KOSDAQ)$/i;
    const symbol = rawSymbol.replace(krxSuffixRegex, '');

    // 6) isDomestic 계산
    const isDomesticRaw = parsed.is_domestic ?? parsed.isDomestic;
    let isDomestic: boolean;

    if (typeof isDomesticRaw === 'boolean') {
      // OpenAI가 명시적으로 준 값이 있으면 그걸 우선 사용
      isDomestic = isDomesticRaw;
    } else {
      // 없으면 심볼 패턴으로 추론
      const upperRaw = rawSymbol.toUpperCase();
      const isSixDigitKr = /^[0-9]{6}$/.test(symbol); // suffix 제거된 심볼이 6자리 숫자면 KRX 코드로 판단
      const hasKrxSuffix = krxSuffixRegex.test(upperRaw);

      isDomestic = isSixDigitKr || hasKrxSuffix;
    }

    return {
      graphId,
      mainKeyword,
      allKeywords,
      symbol, // suffix 제거된 심볼
      isDomestic, // 국내 여부
    };
  }
  /** 1) 30일 종가 + 20 / 60일 이동평균선 */
  async getPriceWithMa(symbol: string) {
    const s = this.normalizeSymbol(symbol);
    // days = 30 고정
    return this.alpha.getClosesWithMa(s, 30);
  }

  // 2) RSI만 단독으로
  async getRsi(symbol: string, period = 30) {
    const s = this.normalizeSymbol(symbol);
    if (!s) {
      throw new BadRequestException('symbol is required');
    }
    // AlphaVantageService에서 마지막 N개 잘라서 주고 있으니 그대로 반환
    return this.alpha.getRsi(s, period);
  }

  // 3) Momentum(MOM)만 단독으로
  async getMomentum(symbol: string, period = 30) {
    const s = this.normalizeSymbol(symbol);
    if (!s) {
      throw new BadRequestException('symbol is required');
    }
    return this.alpha.getMomentum(s, period);
  }

  /** 4) Finnhub 애널리스트 추천 트렌드 (가장 최신 1개만 반환) */
  async getRecommendation(symbol: string) {
    const s = this.normalizeSymbol(symbol);
    const raw = await this.finnhub.getRecommendationTrends(s);

    if (!Array.isArray(raw) || raw.length === 0) {
      // 없으면 null이나 빈 객체 중 하나 선택. 여기선 null로.
      return null;
    }

    // 혹시 순서가 보장 안 된다고 가정하고 period 기준으로 내림차순 정렬
    const sorted = [...raw].sort((a, b) => {
      // period: '2025-11-01' 같은 YYYY-MM-DD 문자열이라고 가정
      if (!a.period && !b.period) return 0;
      if (!a.period) return 1;
      if (!b.period) return -1;
      return a.period < b.period ? 1 : -1; // 최근 것이 앞으로 오게
    });

    return sorted[0]; // 가장 최신 1개만 반환
  }

  /** 5) Finnhub 회사 뉴스 (최근 30일 중에서 가장 최신 20개만 반환) */
  async getCompanyNews(symbol: string) {
    const s = this.normalizeSymbol(symbol);
    if (!s) {
      throw new BadRequestException('symbol is required');
    }

    const to = dayjs().format('YYYY-MM-DD');
    const from = dayjs().subtract(14, 'day').format('YYYY-MM-DD');

    const raw = await this.finnhub.getCompanyNews(s, from, to);

    if (!Array.isArray(raw) || raw.length === 0) {
      return [];
    }

    // datetime(Unix 초) 기준으로 내림차순 정렬 후, 상위 20개만
    const sorted = [...raw].sort((a: any, b: any) => {
      const da = typeof a.datetime === 'number' ? a.datetime : 0;
      const db = typeof b.datetime === 'number' ? b.datetime : 0;
      return db - da; // 최신 -> 오래된 순
    });

    return sorted.slice(0, 20);
  }

  /**
   * 특정 그래프의 wing-score를 계산한다.
   *
   * wing-score 정의:
   *  - sentiment_label 이 'positive' => 엣지 값 +1
   *  - sentiment_label 이 'negative' => 엣지 값 -1
   *  - sentiment_label 이 'neutral'  => 엣지 값  0 (계산에서 제외)
   *
   *  - positive/negative 엣지에 대해 가중치 w_e = (해당 엣지에 속한 뉴스 개수) / (그래프 전체 뉴스 개수)
   *
   *  - 최종 점수:
   *      score_raw = ( Σ_e (edgeValue_e * w_e) ) / (전체 엣지 수)
   *      wingScore = trunc(score_raw * 100)   // 정수부분만 (음수도 0 방향으로 절삭)
   */
  async getWingScoreByGraph(
    user: string,
    graphId: number,
  ): Promise<{ graphId: number; wingScore: number }> {
    const userId = (user ?? '').trim();
    if (!userId) {
      throw new BadRequestException('user id is required');
    }
    if (!graphId || graphId <= 0) {
      throw new BadRequestException('graphId is required');
    }

    // 1) 그래프 존재 여부 검증
    const graph = await this.prisma.graph.findFirst({
      where: { id: graphId, userID: userId },
      select: { id: true },
    });
    if (!graph) {
      throw new BadRequestException('graph not found for this user');
    }

    // 2) 그래프의 모든 엣지 조회
    const edges = await this.prisma.edge.findMany({
      where: { userID: userId, graphId },
    });

    const totalEdges = edges.length;
    if (totalEdges === 0) {
      // 엣지가 없으면 wing-score는 0으로 간주
      return { graphId, wingScore: 0 };
    }

    // 3) 그래프에 속한 전체 뉴스 개수
    const totalNews = await this.prisma.news.count({
      where: { userID: userId, graphId },
    });

    if (totalNews === 0) {
      // 뉴스가 하나도 없으면 가중치는 모두 0이므로 wing-score = 0
      return { graphId, wingScore: 0 };
    }

    // 4) 엣지별 뉴스 개수를 groupBy로 한 번에 가져온다
    const newsGroups = await this.prisma.news.groupBy({
      by: ['startPoint', 'endPoint'],
      where: { userID: userId, graphId },
      _count: { id: true },
    });

    // (startPoint, endPoint) -> 뉴스 개수 매핑
    const newsCountMap = new Map<string, number>();
    for (const g of newsGroups) {
      const key = `${g.startPoint}::${g.endPoint}`;
      const count = (g._count as any).id ?? g._count?.id ?? 0;
      newsCountMap.set(key, count);
    }

    // 5) Σ_e (edgeValue * weight) 계산
    let sum = 0;

    for (const edge of edges) {
      const label = (edge.sentiment_label ?? '').toLowerCase().trim();

      let edgeValue = 0;
      if (label === 'positive') edgeValue = 1;
      else if (label === 'negative') edgeValue = -1;
      else if (label === 'neutral') edgeValue = 0;
      else edgeValue = 0; // 정의 외 값도 0 취급

      // neutral 이거나 정의 안 된 값은 계산에서 제외
      if (edgeValue === 0) {
        continue;
      }

      const key = `${edge.startPoint}::${edge.endPoint}`;
      const edgeNewsCount = newsCountMap.get(key) ?? 0;

      if (edgeNewsCount === 0) {
        // 뉴스가 하나도 없으면 가중치 0 → 기여도 0
        continue;
      }

      const weight = edgeNewsCount / totalNews;
      sum += edgeValue * weight;
    }

    // 6) 전체 엣지 수로 나누고, 100을 곱한 뒤 정수 부분만 취함
    const rawScore = sum / totalEdges; // 보통 -1 ~ +1 범위 (실제로는 더 좁음)
    const scaled = rawScore * 100;

    // 정수로 반올림: 3.4 -> 3, 3.5 -> 4, -3.4 -> -3, -3.5 -> -4
    const wingScore = Math.round(scaled);

    return { graphId, wingScore };
  }

  // ----------------- 헬퍼 -----------------

  private normalizeSymbol(symbol: string): string {
    const s = (symbol ?? '').trim();
    if (!s) {
      throw new BadRequestException('symbol is required');
    }
    return s.toUpperCase();
  }

  private formatDateYYYYMMDD(d: Date): string {
    return d.toISOString().slice(0, 10); // 'YYYY-MM-DD'
  }
}
