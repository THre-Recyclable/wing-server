// src/kis/kis.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiOkResponse,
} from '@nestjs/swagger';
import { KisService } from './kis.service';

@ApiTags('KIS(Mock)')
@Controller('kis/mock')
export class KisController {
  constructor(private readonly kisService: KisService) {}

  @Get('price')
  @ApiOperation({
    summary: 'KIS 모의투자 - 국내주식 현재가 테스트',
    description:
      '모의투자(VTS) 환경에서 국내주식 현재가를 조회합니다. (예: 005930 = 삼성전자)',
  })
  @ApiQuery({
    name: 'code',
    required: true,
    example: '005930',
    description: '종목코드(6자리)',
  })
  @ApiOkResponse({
    description: 'KIS 원본 현재가 응답',
  })
  async getMockPrice(@Query('code') code: string) {
    return this.kisService.inquirePriceMock(code);
  }

  // GET /kis/test/close-ma?code=005930
  @Get('close-ma')
  async getCloseMa(@Query('code') code: string) {
    return this.kisService.getCloseWithMovingAveragesSeries(code);
  }

  // GET /kis/test/rsi?code=005930&period=14
  @Get('rsi')
  async getRsi(@Query('code') code: string, @Query('period') period?: string) {
    const p = period ? Number(period) : 14;
    return this.kisService.getRSISeries(code, p);
  }

  // GET /kis/test/mom?code=005930&period=14
  @Get('mom')
  async getMomentum(
    @Query('code') code: string,
    @Query('period') period?: string,
  ) {
    const p = period ? Number(period) : 14;
    return this.kisService.getMomentumSeries(code, p);
  }

  @Get('stock-recommendation-period')
  async getStockRecommendationPeriod(
    @Query('code') code: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.kisService.getStockInvestmentOpinions({
      stockCode: code,
      from,
      to,
    });
  }

  @Get('stock-recommendation')
  async getStockRecommendation(@Query('code') code: string) {
    return this.kisService.getStockInvestmentOpinionsLastMonth(code);
  }

  // GET /kis/test/reco?code=005930
  @Get('reco')
  async getReco(@Query('code') code: string) {
    return this.kisService.summarizeStockInvestmentOpinionsLastMonth(code);
  }
}
