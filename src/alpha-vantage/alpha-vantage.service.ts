// alpha-vantage/alpha-vantage.service.ts
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class AlphaVantageService {
  private readonly baseUrl = 'https://www.alphavantage.co/query';
  private readonly apiKey = process.env.ALPHAVANTAGE_API_KEY;

  constructor(private readonly http: HttpService) {}

  async getDailyCandles(symbol: string, full = false) {
    try {
      const params = {
        function: 'TIME_SERIES_DAILY_ADJUSTED',
        symbol,
        outputsize: full ? 'full' : 'compact',
        apikey: this.apiKey,
      };

      const { data } = await firstValueFrom(
        this.http.get(this.baseUrl, { params }),
      );

      if (data['Error Message'] || data['Note']) {
        // Note는 rate limit 걸렸을 때 자주 나옴
        throw new InternalServerErrorException(
          data['Error Message'] || data['Note'] || 'AlphaVantage error',
        );
      }

      const series = data['Time Series (Daily)'] ?? {};
      // 원하는 형태로 파싱
      const candles = Object.entries(series).map(([date, v]: any) => ({
        date,
        open: parseFloat(v['1. open']),
        high: parseFloat(v['2. high']),
        low: parseFloat(v['3. low']),
        close: parseFloat(v['4. close']),
        volume: parseInt(v['6. volume'], 10),
      }));

      // 날짜 최신순 정렬 (키는 보통 최신이 먼저지만, 안전하게)
      candles.sort((a, b) => (a.date < b.date ? -1 : 1));

      return candles;
    } catch (e) {
      throw new InternalServerErrorException(
        `AlphaVantage candle fetch failed: ${e.message}`,
      );
    }
  }

  async getRsi(symbol: string, period = 14) {
    const params = {
      function: 'RSI',
      symbol,
      interval: 'weekly',
      time_period: period,
      series_type: 'close',
      apikey: this.apiKey,
    };

    const { data } = await firstValueFrom(
      this.http.get(this.baseUrl, { params }),
    );

    if (data['Error Message'] || data['Note']) {
      throw new InternalServerErrorException(
        data['Error Message'] || data['Note'] || 'AlphaVantage error',
      );
    }

    const series = data['Technical Analysis: RSI'] ?? {};
    const points = Object.entries(series).map(([date, v]: any) => ({
      date,
      rsi: parseFloat(v['RSI']),
    }));
    points.sort((a, b) => (a.date < b.date ? -1 : 1));

    const lastN = 10;
    return points.slice(-lastN);
  }

  async getMomentum(symbol: string, period = 10) {
    const params = {
      function: 'MOM',
      symbol,
      interval: 'daily',
      time_period: period,
      series_type: 'close',
      apikey: this.apiKey,
    };

    const { data } = await firstValueFrom(
      this.http.get(this.baseUrl, { params }),
    );

    if (data['Error Message'] || data['Note']) {
      throw new InternalServerErrorException(
        data['Error Message'] || data['Note'] || 'AlphaVantage error',
      );
    }

    const series = data['Technical Analysis: MOM'] ?? {};

    const points = Object.entries(series).map(([date, v]: any) => ({
      date,
      mom: parseFloat(v['MOM']),
    }));

    points.sort((a, b) => (a.date < b.date ? -1 : 1));

    const lastN = 10;
    return points.slice(-lastN);
  }

  async getMacd(symbol: string) {
    const params = {
      function: 'MACD',
      symbol,
      interval: 'daily',
      series_type: 'close',
      apikey: this.apiKey,
      // fastperiod: 12,
      // slowperiod: 26,
      // signalperiod: 9,
    };

    const { data } = await firstValueFrom(
      this.http.get(this.baseUrl, { params }),
    );

    if (data['Error Message'] || data['Note']) {
      throw new InternalServerErrorException(
        data['Error Message'] || data['Note'] || 'AlphaVantage error',
      );
    }

    const series = data['Technical Analysis: MACD'] ?? {};

    const points = Object.entries(series).map(([date, v]: any) => ({
      date,
      macd: parseFloat(v['MACD']),
      macdSignal: parseFloat(v['MACD_Signal']),
      macdHist: parseFloat(v['MACD_Hist']),
    }));

    // 날짜 오름차순 정렬
    points.sort((a, b) => (a.date < b.date ? -1 : 1));

    const lastN = 10;
    return points.slice(-lastN);
  }

  // 👉 여기 아래에 함수 추가
  async getRecentCloses(
    symbol: string,
    n = 30,
  ): Promise<{ date: string; close: number }[]> {
    if (!symbol?.trim()) {
      throw new InternalServerErrorException('symbol is required');
    }
    if (n <= 0) {
      throw new InternalServerErrorException('n must be > 0');
    }

    // Alpha Vantage는 outputsize=compact(최근 100개), full(전부)
    const outputsize = 'compact';

    const params = {
      function: 'TIME_SERIES_DAILY', // 또는 TIME_SERIES_DAILY_ADJUSTED
      symbol,
      outputsize,
      apikey: this.apiKey,
    };

    const { data } = await firstValueFrom(
      this.http.get(this.baseUrl, { params }),
    );

    // 에러/레이트리밋 메시지 처리
    if (data['Error Message'] || data['Note']) {
      throw new InternalServerErrorException(
        data['Error Message'] || data['Note'] || 'AlphaVantage error',
      );
    }

    const series = data['Time Series (Daily)'];
    if (!series) {
      throw new InternalServerErrorException(
        'No "Time Series (Daily)" field in AlphaVantage response',
      );
    }

    // series는 { '2025-12-04': { '1. open': '...', '4. close': '...' }, ... }
    const points = Object.entries(series).map(([date, v]: [string, any]) => ({
      date, // 'YYYY-MM-DD'
      close: parseFloat(v['4. close']), // 또는 '5. adjusted close' 써도 됨
    }));

    // 오래된 날짜 → 최신 날짜 순으로 정렬
    points.sort((a, b) => (a.date < b.date ? -1 : 1));

    // 뒤에서 n개만 잘라서 반환
    return points.slice(-n);
  }

  async getClosesWithMa(
    symbol: string,
    days = 30, // 마지막 n일만 내려줄 개수
  ) {
    // 200일 이평선을 계산하려면 최소 200일 데이터가 필요하니까
    const requiredHistory = Math.max(days, 200);

    const params = {
      function: 'TIME_SERIES_DAILY',
      symbol,
      outputsize: 'compact',
      apikey: this.apiKey,
    };

    const { data } = await firstValueFrom(
      this.http.get(this.baseUrl, { params }),
    );

    if (data['Error Message'] || data['Note']) {
      throw new InternalServerErrorException(
        data['Error Message'] || data['Note'] || 'AlphaVantage error',
      );
    }

    const series = data['Time Series (Daily)'] ?? {};
    // { '2025-12-04': { '1. open': '...', '4. close': '...' }, ... }

    // 날짜 오름차순으로 정렬
    const points = Object.entries(series)
      .map(([date, v]: any) => ({
        date, // 'YYYY-MM-DD'
        close: parseFloat(v['4. close']),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    const closes = points.map((p) => p.close);

    const smaAt = (idx: number, window: number): number | null => {
      if (idx + 1 < window) return null; // 데이터 부족하면 null
      let sum = 0;
      for (let i = idx - window + 1; i <= idx; i++) {
        sum += closes[i];
      }
      return sum / window;
    };

    const enriched = points.map((p, idx) => ({
      date: p.date,
      close: p.close,
      ma20: smaAt(idx, 20),
      ma60: smaAt(idx, 60),
    }));

    // 마지막 n일만 반환 (가장 최근 days개)
    const result =
      enriched.length > days
        ? enriched.slice(enriched.length - days)
        : enriched;

    return result;
  }
}
