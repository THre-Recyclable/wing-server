// src/finnhub/finnhub.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import { FinnhubService } from './finnhub.service';

@Controller('finnhub')
export class FinnhubController {
  constructor(private readonly finnhubService: FinnhubService) {}

  @Get('quote')
  async getQuote(@Query('symbol') symbol: string) {
    // 예: GET /finnhub/quote?symbol=NVDA
    return this.finnhubService.getQuote(symbol);
  }

  @Get('recommendation')
  async getRec(@Query('symbol') symbol: string) {
    return this.finnhubService.getRecommendationTrends(symbol);
  }

  @Get('price-target')
  async getPriceTarget(@Query('symbol') symbol: string) {
    return this.finnhubService.getPriceTarget(symbol);
  }

  @Get('company-news')
  async getCompanyNews(
    @Query('symbol') symbol: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.finnhubService.getCompanyNews(symbol, from, to);
  }
}
