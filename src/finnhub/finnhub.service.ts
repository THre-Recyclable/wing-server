// src/finnhub/finnhub.service.ts
import { Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

@Injectable()
export class FinnhubService {
  private client: AxiosInstance;
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.FINNHUB_API_KEY ?? '';
    if (!this.apiKey) {
      // 실제로는 Logger.warn 정도로만 하고, 앱 자체가 죽지 않게 처리가 더 좋음
      console.warn('[FinnhubService] FINNHUB_API_KEY가 .env에 없습니다.');
    }

    this.client = axios.create({
      baseURL: 'https://finnhub.io/api/v1',
      timeout: 5000,
    });
  }

  // 공용 헬퍼: GET 호출 시 항상 token 자동으로 붙여줌
  private async get<T = any>(url: string, params: Record<string, any> = {}) {
    const merged = { token: this.apiKey, ...params };
    const resp = await this.client.get<T>(url, { params: merged });
    return resp.data;
  }

  /**
   * 1) 특정 종목 실시간/지연 시세 예시 (quote)
   *    - symbol: 'AAPL', 'TSLA', 'NVDA', '005930.KS'(삼성전자) 같은 식
   */
  async getQuote(symbol: string) {
    return this.get('/quote', { symbol });
  }

  /**
   * 2) 회사 기본 정보 (profile2)
   */
  async getCompanyProfile(symbol: string) {
    return this.get('/stock/profile2', { symbol });
  }

  /**
   * 3) 애널리스트 타겟 프라이스 / 리코멘데이션 트렌드 같은 것들
   */
  async getRecommendationTrends(symbol: string) {
    return this.get('/stock/recommendation', { symbol });
  }

  async getPriceTarget(symbol: string) {
    return this.get('/stock/price-target', { symbol });
  }

  /**
   * 4) 뉴스 (심볼 기반)
   */
  async getCompanyNews(symbol: string, from: string, to: string) {
    // from/to: '2025-11-01' 이런 식의 YYYY-MM-DD 포맷
    return this.get('/company-news', { symbol, from, to });
  }
}
