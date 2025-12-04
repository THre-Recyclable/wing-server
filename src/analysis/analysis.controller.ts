// src/analysis/analysis.controller.ts
import {
  Controller,
  Get,
  Query,
  Param,
  ParseIntPipe,
  Request,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AnalysisService } from './analysis.service';
import { AuthGuard } from 'src/auth/auth.guard';

@ApiTags('Analysis')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('analysis')
export class AnalysisController {
  constructor(private readonly analysisService: AnalysisService) {}

  @Get('graphs/:graphId/symbol')
  @ApiOperation({
    summary:
      '그래프의 키워드를 기반으로 가장 관련성 높은 주식 심볼을 추론합니다.',
  })
  @ApiOkResponse({
    description: '그래프와 가장 관련성 높은 주식 심볼',
    schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', example: 'NVDA' },
      },
      example: {
        graphId: 4,
        mainKeyword: 'AI',
        allKeywords: ['AI', '미국', '반도체', '중국', '그래픽카드'],
        symbol: 'NVDA',
      },
    },
  })
  @ApiUnauthorizedResponse({ description: '인증 필요' })
  async getGraphSymbol(
    @Request() req,
    @Param('graphId', ParseIntPipe) graphId: number,
  ) {
    const id = req?.user?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new UnauthorizedException('유효한 사용자 id가 필요합니다.');
    }

    return this.analysisService.resolveGraphSymbol(id, graphId);
  }

  // 1) 30일 종가 + 20/60일 이동평균선
  @Get('price-ma')
  @ApiOperation({
    summary: '특정 종목의 30일 종가와 20/60일 이동평균선을 조회합니다.',
  })
  @ApiQuery({
    name: 'symbol',
    type: String,
    required: true,
    example: 'TSLA',
    description: '조회할 종목 심볼 (예: TSLA, NVDA, AAPL 등)',
  })
  @ApiOkResponse({
    description: '날짜별 종가 + 20/60일 이동평균선 배열',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', example: '2025-11-10' },
          close: { type: 'number', example: 230.15 },
          ma20: { type: 'number', nullable: true, example: 225.3 },
          ma60: { type: 'number', nullable: true, example: 210.7 },
        },
      },
      example: [
        {
          date: '2025-11-01',
          close: 220.5,
          ma20: null,
          ma60: null,
        },
        {
          date: '2025-11-02',
          close: 222.1,
          ma20: null,
          ma60: null,
        },
        {
          date: '2025-11-25',
          close: 235.9,
          ma20: 228.4,
          ma60: 215.2,
        },
      ],
    },
  })
  @ApiUnauthorizedResponse({ description: '인증 필요' })
  async getPriceWithMa(@Query('symbol') symbol: string) {
    return this.analysisService.getPriceWithMa(symbol);
  }

  // 2) RSI만
  @Get('rsi')
  @ApiOperation({
    summary: 'RSI 지표 (AlphaVantage, 기본 period=14)',
  })
  @ApiQuery({ name: 'symbol', required: true, example: 'TSLA' })
  @ApiQuery({
    name: 'period',
    required: false,
    example: 14,
    description: 'RSI 계산 기간 (기본 14)',
  })
  @ApiOkResponse({
    description: 'RSI 값 배열 (AlphaVantage가 반환한 최근 N개)',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', example: '2025-11-10' },
          rsi: { type: 'number', example: 57.32 },
        },
      },
      example: [
        { date: '2025-09-15', rsi: 42.11 },
        { date: '2025-09-22', rsi: 48.27 },
        { date: '2025-09-29', rsi: 55.03 },
        { date: '2025-10-06', rsi: 61.89 },
      ],
    },
  })
  @ApiUnauthorizedResponse({ description: '인증 필요' })
  async getRsi(
    @Query('symbol') symbol: string,
    @Query('period') period = '14',
  ) {
    return this.analysisService.getRsi(symbol, Number(period));
  }

  // 3) Momentum(MOM)만
  @Get('momentum')
  @ApiOperation({
    summary: 'Momentum(MOM) 지표 (AlphaVantage, 기본 period=10)',
  })
  @ApiQuery({ name: 'symbol', required: true, example: 'TSLA' })
  @ApiQuery({
    name: 'period',
    required: false,
    example: 10,
    description: 'MOM 계산 기간 (기본 10)',
  })
  @ApiOkResponse({
    description: 'MOM 값 배열 (AlphaVantage가 반환한 최근 N개)',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', example: '2025-11-10' },
          mom: { type: 'number', example: 3.21 },
        },
      },
      example: [
        { date: '2025-11-01', mom: -1.23 },
        { date: '2025-11-02', mom: 0.45 },
        { date: '2025-11-03', mom: 2.87 },
        { date: '2025-11-04', mom: 3.21 },
      ],
    },
  })
  @ApiUnauthorizedResponse({ description: '인증 필요' })
  async getMomentum(
    @Query('symbol') symbol: string,
    @Query('period') period = '10',
  ) {
    return this.analysisService.getMomentum(symbol, Number(period));
  }

  // 4) Finnhub 애널리스트 추천 트렌드
  @Get('recommendation')
  @ApiOperation({
    summary: 'Finnhub 애널리스트 추천 트렌드 중 가장 최신 한 건만 조회합니다.',
  })
  @ApiQuery({
    name: 'symbol',
    type: String,
    required: true,
    example: 'TSLA',
  })
  @ApiOkResponse({
    description: '가장 최신 recommendation 레코드 1개 (없으면 null)',
    schema: {
      type: 'object',
      nullable: true,
      properties: {
        symbol: { type: 'string', example: 'TSLA' },
        period: { type: 'string', example: '2025-11-01' },
        strongBuy: { type: 'integer', example: 12 },
        buy: { type: 'integer', example: 8 },
        hold: { type: 'integer', example: 3 },
        sell: { type: 'integer', example: 1 },
        strongSell: { type: 'integer', example: 0 },
      },
      example: {
        buy: 39,
        hold: 7,
        period: '2025-12-01',
        sell: 1,
        strongBuy: 25,
        strongSell: 0,
        symbol: 'NVDA',
      },
    },
  })
  @ApiUnauthorizedResponse({ description: '인증 필요' })
  async getRecommendation(@Query('symbol') symbol: string) {
    return this.analysisService.getRecommendation(symbol);
  }

  // 5) Finnhub 회사 뉴스 (최근 30일)
  @Get('company-news')
  @ApiOperation({
    summary:
      'Finnhub 회사 뉴스: 최근 30일 범위에서 가장 최신 20개만 반환합니다.',
  })
  @ApiQuery({
    name: 'symbol',
    type: String,
    required: true,
    example: 'TSLA',
  })
  @ApiOkResponse({
    description: '최신 회사 뉴스 최대 20개',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          datetime: { type: 'integer', example: 1762147200 }, // unix timestamp
          headline: {
            type: 'string',
            example: 'Tesla beats earnings expectations for Q3 2025',
          },
          source: { type: 'string', example: 'Reuters' },
          summary: {
            type: 'string',
            example: 'Tesla reported better-than-expected earnings ...',
          },
          url: {
            type: 'string',
            example: 'https://finnhub.io/news/123456',
          },
          image: {
            type: 'string',
            example: 'https://finnhub.io/api/news-image/123456',
          },
          related: { type: 'string', example: 'TSLA' },
        },
      },
      example: [
        {
          category: 'company',
          datetime: 1764841740,
          headline:
            "Investing in Artificial Intelligence (AI) Can Be Risky, but Here's a Magnificent Way to Do It",
          id: 137677566,
          image:
            'https://s.yimg.com/rz/stage/p/yahoo_finance_en-US_h_p_finance_2.png',
          related: 'NVDA',
          source: 'Yahoo',
          summary:
            'Buying an exchange-traded fund can help smooth out some of the volatility that comes with investing in AI.',
          url: 'https://finnhub.io/api/news?id=64e6ca9b709bb6ba636e154644437527232e6faee837cb40ae961bd67e77bbf0',
        },
        {
          category: 'company',
          datetime: 1764840696,
          headline:
            'Palantir teams with Nvidia, CenterPoint Energy for software to speed up AI data center construction',
          id: 137677567,
          image:
            'https://s.yimg.com/rz/stage/p/yahoo_finance_en-US_h_p_finance_2.png',
          related: 'NVDA',
          source: 'Yahoo',
          summary:
            'Palantir Technologies, Nvidia and U.S. utility CenterPoint Energy on Thursday said they are developing a new ​software platform to accelerate the building of new artificial intelligence data centers.  The ‌new software system will be called Chain Reaction.  It will seek to help firms that are building ‌AI data centers, which can consume as much electricity as a small city, with permitting, supply chain and construction challenges.',
          url: 'https://finnhub.io/api/news?id=5ca43f9219a536056f3a099676be45f7c181affec3eba403c4cd65e9c52c3380',
        },
      ],
    },
  })
  @ApiUnauthorizedResponse({ description: '인증 필요' })
  async getCompanyNews(@Query('symbol') symbol: string) {
    return this.analysisService.getCompanyNews(symbol);
  }
}
