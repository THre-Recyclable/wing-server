// alpha-vantage/alpha-vantage.controller.ts
// API 테스트용 컨트롤러
import { Controller, Get, Query } from '@nestjs/common';
import { AlphaVantageService } from './alpha-vantage.service';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

@ApiTags('AlphaVantage')
@Controller('alpha')
export class AlphaVantageController {
  constructor(private readonly alpha: AlphaVantageService) {}

  @Get('candles')
  @ApiOperation({ summary: 'AlphaVantage 일봉 캔들 조회' })
  @ApiQuery({ name: 'symbol', required: true, example: 'TSLA' })
  async getCandles(@Query('symbol') symbol: string) {
    return this.alpha.getDailyCandles(symbol);
  }

  @Get('rsi')
  @ApiOperation({ summary: 'AlphaVantage RSI 조회' })
  @ApiQuery({ name: 'symbol', required: true, example: 'TSLA' })
  @ApiQuery({ name: 'period', required: false, example: 14 })
  async getRsi(
    @Query('symbol') symbol: string,
    @Query('period') period?: string,
  ) {
    const p = period ? parseInt(period, 10) : 14;
    return this.alpha.getRsi(symbol, p);
  }

  @Get('mom')
  @ApiOperation({ summary: 'AlphaVantage MOM 조회' })
  @ApiQuery({ name: 'symbol', required: true, example: 'TSLA' })
  @ApiQuery({ name: 'period', required: false, example: 10 })
  async getMom(
    @Query('symbol') symbol: string,
    @Query('period') period?: string,
  ) {
    const p = period ? parseInt(period, 10) : 10;
    return this.alpha.getMomentum(symbol, p);
  }

  @Get('macd')
  @ApiOperation({ summary: 'AlphaVantage MACD 조회' })
  @ApiQuery({ name: 'symbol', required: true, example: 'TSLA' })
  async getMacd(@Query('symbol') symbol: string) {
    return this.alpha.getMacd(symbol);
  }

  @Get('recent-closes')
  async getRecentCloses(@Query('symbol') symbol: string, @Query('n') n = '30') {
    return this.alpha.getRecentCloses(symbol, Number(n));
  }

  @Get('closes-with-ma')
  async getClosesWithMa(
    @Query('symbol') symbol: string,
    @Query('days') days = '30',
  ) {
    return this.alpha.getClosesWithMa(symbol, Number(days));
  }
}
