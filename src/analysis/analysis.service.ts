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

  /**
   * 특정 graphId에 대해, 해당 그래프의 키워드들을 보고
   * - 메인 키워드가 곧 종목명이라면 그 종목 심볼
   * - 아니면 (메인+서브 전체 기준으로) 가장 관련성 높은 종목 하나의 심볼
   * 을 OpenAI에게 물어서 반환.
   */
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
    const mainNode = nodes.find((n: any) => n.kind === 'MAIN') ?? nodes[0]; // 혹시 kind가 없거나 잘못된 경우 대비
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
        '2. 그렇다면 해당 기업의 주식 티커(symbol)를 chosen_symbol에 넣어라. (예: "엔비디아" -> "NVDA", "테슬라" -> "TSLA")',
        '3. main_keyword가 AI, 반도체, 전기차 같은 테마/산업이면, all_keywords 전체를 보고 가장 관련성이 높은 상장 기업 하나를 고르고 그 티커를 chosen_symbol에 넣어라.',
        '4. 미국/글로벌에 상장된, 널리 알려진 티커를 우선적으로 선택하라.',
        '5. 반드시 JSON 형식으로만 답하라.',
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
            'You are a stock symbol resolver. You receive Korean or English keywords and must output the single most relevant stock ticker symbol (e.g. NVDA, TSLA). Always respond with strict JSON.',
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

    const symbol: string = (parsed.chosen_symbol ?? parsed.symbol ?? '')
      .toString()
      .trim();

    if (!symbol) {
      throw new InternalServerErrorException(
        'OpenAI did not return a stock symbol',
      );
    }

    return {
      graphId,
      mainKeyword,
      allKeywords,
      symbol,
    };
  }

  /** 1) 30일 종가 + 20 / 60일 이동평균선 */
  async getPriceWithMa(symbol: string) {
    const s = this.normalizeSymbol(symbol);
    // days = 30 고정
    return this.alpha.getClosesWithMa(s, 30);
  }

  // 2) RSI만 단독으로
  async getRsi(symbol: string, period = 14) {
    const s = this.normalizeSymbol(symbol);
    if (!s) {
      throw new BadRequestException('symbol is required');
    }
    // AlphaVantageService에서 마지막 N개 잘라서 주고 있으니 그대로 반환
    return this.alpha.getRsi(s, period);
  }

  // 3) Momentum(MOM)만 단독으로
  async getMomentum(symbol: string, period = 10) {
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
    const from = dayjs().subtract(30, 'day').format('YYYY-MM-DD');

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
