// src/kis/kis.service.ts
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { DomesticRecommendationDto } from './dto/domestic-recommendation.dto';

interface DailyCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface KisStockOpinionItem {
  stck_bsop_date: string;
  invt_opnn: string;
  invt_opnn_cls_code: string;
  rgbf_invt_opnn: string;
  rgbf_invt_opnn_cls_code: string;
  mbcr_name: string;
  hts_goal_prc: string;
  stck_prdy_clpr: string;
  stck_nday_esdg: string;
  nday_dprt: string;
  stft_esdg: string;
  dprt: string;
}

export interface KisStockOpinionResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output?: KisStockOpinionItem[];
}

export interface RecommendationSummary {
  buy: number;
  hold: number;
  sell: number;
  strongBuy: number;
  strongSell: number;
  period: string;
  symbol: string;
}

@Injectable()
export class KisService {
  private readonly baseUrl: string;
  private readonly appKey: string;
  private readonly appSecret: string;

  private accessToken: string | null = null;
  private tokenExpireAt: number | null = null; // ms timestamp

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {
    this.baseUrl = this.config.get<string>('KIS_BASE_URL')!;
    this.appKey = this.config.get<string>('KIS_APP_KEY')!;
    this.appSecret = this.config.get<string>('KIS_APP_SECRET')!;
  }

  /** 모의투자용 액세스 토큰 받기 (캐싱 포함) */
  private async getAccessToken(): Promise<string> {
    const now = Date.now();

    if (this.accessToken && this.tokenExpireAt && now < this.tokenExpireAt) {
      return this.accessToken;
    }

    const url = `${this.baseUrl}/oauth2/tokenP`;

    const body = {
      grant_type: 'client_credentials',
      appkey: this.appKey,
      appsecret: this.appSecret,
    };

    const { data } = await firstValueFrom(
      this.http.post(url, body, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
        },
      }),
    );

    if (!data?.access_token) {
      throw new InternalServerErrorException(
        `KIS 토큰 발급 실패: ${JSON.stringify(data)}`,
      );
    }

    const expiresIn = Number(data.expires_in ?? 0); // 보통 초 단위
    this.accessToken = data.access_token;
    this.tokenExpireAt = now + (expiresIn - 60) * 1000; // 만료 1분 전부터 재발급

    return this.accessToken!;
  }

  /**
   * 모의투자용 국내주식 현재가 조회 테스트
   *  - 예: code = '005930' (삼성전자)
   */
  async inquirePriceMock(code: string) {
    const token = await this.getAccessToken();

    const url = `${this.baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price`;

    const params = {
      fid_cond_mrkt_div_code: 'J', // 코스피/코스닥 통합 코드 (모의에서도 동일)
      fid_input_iscd: code, // 종목코드 6자리
    };

    const headers = {
      authorization: `Bearer ${token}`,
      appkey: this.appKey,
      appsecret: this.appSecret,
      tr_id: 'FHKST01010100', // ✅ 모의투자(VTS)용 현재가 TR ID
      custtype: 'P', // 개인
    };

    const { data } = await firstValueFrom(
      this.http.get(url, { headers, params }),
    );

    // 에러 여부 간단 체크
    if (data.rt_cd && data.rt_cd !== '0') {
      throw new InternalServerErrorException(
        `KIS 현재가 조회 실패: ${data.msg1 ?? 'unknown error'}`,
      );
    }

    return data;
  }

  /**
   * KIS 기간별 시세(일봉) 조회
   * - days: 대략 며칠치가 필요한지 (휴장일 감안해서 여유있게)
   */
  private async fetchDailyCandles(
    code: string,
    days = 120,
  ): Promise<DailyCandle[]> {
    const token = await this.getAccessToken();

    const end = new Date();
    const start = new Date();
    // 휴장일 감안해서 여유 있게 +10일 정도 더
    start.setDate(end.getDate() - (days + 10));

    const FID_INPUT_DATE_1 = this.formatDate(start);
    const FID_INPUT_DATE_2 = this.formatDate(end);

    const url = `${this.baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`;

    const headers = {
      authorization: `Bearer ${token}`,
      appkey: this.appKey,
      appsecret: this.appSecret,
      tr_id: 'FHKST03010100', // 국내주식기간별시세(일/주/월/년)
      custtype: 'P',
    };

    const params = {
      FID_COND_MRKT_DIV_CODE: 'J', // 코스피+코스닥
      FID_INPUT_ISCD: code, // 종목코드 6자리
      FID_INPUT_DATE_1,
      FID_INPUT_DATE_2,
      FID_PERIOD_DIV_CODE: 'D', // D: 일봉
      FID_ORG_ADJ_PRC: '1', // 1: 원주가(필요하면 0=수정주가로 변경)
    };

    const { data } = await firstValueFrom(
      this.http.get(url, { headers, params }),
    );

    if (data.rt_cd && data.rt_cd !== '0') {
      throw new InternalServerErrorException(
        `KIS 일봉 조회 실패: ${data.msg1 ?? 'unknown error'}`,
      );
    }

    const rows = data.output2 ?? [];
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new InternalServerErrorException('일봉 데이터가 없습니다.');
    }

    const candles: DailyCandle[] = rows.map((row: any) => ({
      date: row.stck_bsop_date, // 영업일자
      open: Number(row.stck_oprc),
      high: Number(row.stck_hgpr),
      low: Number(row.stck_lwpr),
      close: Number(row.stck_clpr),
      volume: Number(row.acml_vol ?? row.stck_trdvol ?? 0),
    }));

    // KIS는 보통 최신 날짜가 먼저 오므로, 계산 편하게 오래된 순으로 정렬
    candles.sort((a, b) => a.date.localeCompare(b.date));

    return candles;
  }

  /**
   * 종가 + 20일 / 60일 이동평균
   */
  async getCloseAndMovingAverages(code: string) {
    // 60일 + RSI용 여유분까지 넉넉히 120일
    const candles = await this.fetchDailyCandles(code, 120);

    const latest = candles[candles.length - 1];

    const ma20 = this.calcSMA(candles, 20);
    const ma60 = this.calcSMA(candles, 60);

    return {
      code,
      date: latest.date,
      close: latest.close,
      ma20,
      ma60,
    };
  }

  async getRSI(code: string, period = 14) {
    // RSI 계산도 60일+ 여유분이면 충분함
    const candles = await this.fetchDailyCandles(code, 120);
    const latest = candles[candles.length - 1];

    const rsi = this.calcRSI(candles, period);

    return {
      code,
      date: latest.date,
      rsiPeriod: period,
      rsi,
    };
  }

  async getMomentum(code: string, period = 10) {
    const candles = await this.fetchDailyCandles(code, 120);
    const latest = candles[candles.length - 1];

    const { value, pct } = this.calcMomentum(candles, period);

    return {
      code,
      date: latest.date,
      momentumPeriod: period,
      momentum: value, // C(t) - C(t-N)
      momentumPct: pct, // 변화율 %
    };
  }

  /**
   * 최근 1개월 동안의 종가 + 20일/60일 MA 시계열
   */
  async getCloseWithMovingAveragesSeries(code: string) {
    // 60일 MA를 위해 적어도 60일 + 여유분 필요 → 120일 정도
    const candles = await this.fetchDailyCandles(code, 120);
    const fromDateStr = this.getOneMonthAgoString();

    const results: {
      date: string; // 'YYYY-MM-DD'
      close: number;
      ma20: number | null;
      ma60: number | null;
    }[] = [];

    const closes = candles.map((c) => c.close);

    const toYMDHyphen = (yyyymmdd: string) =>
      `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];

      // 최근 1개월 이전 데이터는 결과에서 제외
      if (c.date < fromDateStr) continue;

      // MA20
      let ma20: number | null = null;
      if (i >= 19) {
        let sum20 = 0;
        for (let j = i - 19; j <= i; j++) sum20 += closes[j];
        ma20 = Number((sum20 / 20).toFixed(2));
      }

      // MA60
      let ma60: number | null = null;
      if (i >= 59) {
        let sum60 = 0;
        for (let j = i - 59; j <= i; j++) sum60 += closes[j];
        ma60 = Number((sum60 / 60).toFixed(2));
      }

      results.push({
        date: toYMDHyphen(c.date),
        close: c.close,
        ma20,
        ma60,
      });
    }

    return results;
  }

  /**
   * 최근 1개월 동안의 RSI 시계열
   * - period 기본 14
   */
  async getRSISeries(code: string, period = 14) {
    const candles = await this.fetchDailyCandles(code, 120);
    const fromDateStr = this.getOneMonthAgoString();
    const closes = candles.map((c) => c.close);

    if (candles.length <= period) {
      throw new InternalServerErrorException(
        `RSI 계산에 필요한 일수가 부족합니다. (필요: 최소 ${period + 1}일)`,
      );
    }

    const rsiArr: (number | null)[] = new Array(candles.length).fill(null);

    // 1) 초기 평균 (period일)
    let gainSum = 0;
    let lossSum = 0;
    for (let i = 1; i <= period; i++) {
      const delta = closes[i] - closes[i - 1];
      if (delta > 0) gainSum += delta;
      else lossSum -= delta;
    }

    let avgGain = gainSum / period;
    let avgLoss = lossSum / period;

    // 초기 RSI (인덱스 = period)
    if (avgLoss === 0) {
      rsiArr[period] = 100;
    } else {
      const rs = avgGain / avgLoss;
      rsiArr[period] = Number((100 - 100 / (1 + rs)).toFixed(2));
    }

    // 2) Wilder smoothing
    for (let i = period + 1; i < closes.length; i++) {
      const delta = closes[i] - closes[i - 1];
      const gain = delta > 0 ? delta : 0;
      const loss = delta < 0 ? -delta : 0;

      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;

      if (avgLoss === 0) {
        rsiArr[i] = 100;
      } else {
        const rs = avgGain / avgLoss;
        const rsi = 100 - 100 / (1 + rs);
        rsiArr[i] = Number(rsi.toFixed(2));
      }
    }

    const toYMDHyphen = (yyyymmdd: string) =>
      `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

    const results: { date: string; rsi: number }[] = [];

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const rsi = rsiArr[i];

      // 1개월 이내 + RSI가 계산된 날만
      if (c.date >= fromDateStr && rsi != null) {
        results.push({
          date: toYMDHyphen(c.date),
          rsi,
        });
      }
    }

    return results;
  }

  /**
   * 최근 1개월 동안의 모멘텀 시계열
   * - period 기본 10 (MOM10)
   */
  async getMomentumSeries(code: string, period = 14) {
    const candles = await this.fetchDailyCandles(code, 120);
    const fromDateStr = this.getOneMonthAgoString();
    const closes = candles.map((c) => c.close);

    if (candles.length <= period) {
      throw new InternalServerErrorException(
        `모멘텀 계산에 필요한 일수가 부족합니다. (필요: 최소 ${period + 1}일)`,
      );
    }

    const toYMDHyphen = (yyyymmdd: string) =>
      `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

    const results: { date: string; mom: number }[] = [];

    for (let i = period; i < candles.length; i++) {
      const c = candles[i];
      const prevClose = closes[i - period];
      const mom = c.close - prevClose;

      if (c.date >= fromDateStr) {
        results.push({
          date: toYMDHyphen(c.date),
          mom: Number(mom.toFixed(2)),
        });
      }
    }

    return results;
  }

  /**
   * 국내주식 종목투자의견 조회
   * - 특정 종목에 대해, 기간 내 증권사들의 투자의견 리스트
   */
  async getStockInvestmentOpinions(params: {
    stockCode: string; // 예: '005930'
    from: string; // 예: '20240501' (YYYYMMDD)
    to: string; // 예: '20240531'
  }): Promise<KisStockOpinionResponse> {
    const token = await this.getAccessToken();

    const url = `${this.baseUrl}/uapi/domestic-stock/v1/quotations/invest-opinion`;

    const { stockCode, from, to } = params;

    const query = {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_COND_SCR_DIV_CODE: '16633',
      FID_INPUT_ISCD: stockCode,
      FID_INPUT_DATE_1: this.formatKisDate(from),
      FID_INPUT_DATE_2: this.formatKisDate(to),
    };

    const headers = {
      authorization: `Bearer ${token}`,
      appkey: this.appKey,
      appsecret: this.appSecret,
      tr_id: 'FHKST663300C0',
      custtype: 'P',
    };

    const { data } = await firstValueFrom(
      this.http.get<KisStockOpinionResponse>(url, { headers, params: query }),
    );

    if (data.rt_cd && data.rt_cd !== '0') {
      throw new InternalServerErrorException(
        `KIS 종목투자의견 조회 실패: ${data.msg1 ?? 'unknown error'}`,
      );
    }

    return data;
  }

  /**
   * 국내주식 종목투자의견 (최근 1개월 고정)
   *  - stockCode: 종목코드(6자리, 예: '005930')
   */
  async getStockInvestmentOpinionsLastMonth(stockCode: string) {
    const token = await this.getAccessToken();

    const url = `${this.baseUrl}/uapi/domestic-stock/v1/quotations/invest-opinion`;
    const { from, to } = this.getLastMonthRange();

    const params = {
      FID_COND_MRKT_DIV_CODE: 'J', // 코스피/코스닥 통합
      FID_COND_SCR_DIV_CODE: '16633', // 문서에 나온 조건 화면 코드
      FID_INPUT_ISCD: stockCode, // 종목코드 6자리
      FID_INPUT_DATE_1: this.formatKisDate(from),
      FID_INPUT_DATE_2: this.formatKisDate(to),
    };

    const headers = {
      authorization: `Bearer ${token}`,
      appkey: this.appKey,
      appsecret: this.appSecret,
      tr_id: 'FHKST663300C0', // 종목투자의견 TR
      custtype: 'P',
    };

    const { data } = await firstValueFrom(
      this.http.get(url, { headers, params }),
    );

    if (data.rt_cd && data.rt_cd !== '0') {
      throw new InternalServerErrorException(
        `KIS 종목투자의견 조회 실패: ${data.msg1 ?? 'unknown error'}`,
      );
    }

    // data.output 이 배열로 내려옴 (증권사/날짜별 투자의견 리스트)
    return data;
  }

  async summarizeStockInvestmentOpinionsLastMonth(stockCode: string): Promise<{
    buy: number;
    hold: number;
    sell: number;
    strongBuy: number;
    strongSell: number;
    period: string;
    symbol: string;
  }> {
    // 1) 원본 KIS 데이터 조회
    const data = await this.getStockInvestmentOpinionsLastMonth(stockCode);

    const output = Array.isArray(data.output) ? data.output : [];
    let buy = 0;
    let hold = 0;
    let sell = 0;

    // period 계산용으로 가장 이른 날짜 찾기
    let earliestDate: string | null = null; // 'YYYYMMDD' 형태

    // 2) 코드별로 카운트
    for (const row of output) {
      const cls: string | undefined = row.invt_opnn_cls_code;

      if (cls === '2') buy++;
      else if (cls === '3') hold++;
      else if (cls === '1') sell++;

      const d: string | undefined = row.stck_bsop_date;
      if (d && d.length === 8) {
        if (!earliestDate || d < earliestDate) {
          earliestDate = d;
        }
      }
    }

    // 3) period 문자열 결정 (가장 이른 영업일 기준)
    //    없으면 getLastMonthRange().from 기준 사용
    let periodYmd = earliestDate;
    if (!periodYmd) {
      const { from } = this.getLastMonthRange(); // 'YYYYMMDD' 형식이라고 가정
      periodYmd = from;
    }
    const period =
      `${periodYmd.slice(0, 4)}-` +
      `${periodYmd.slice(4, 6)}-` +
      `${periodYmd.slice(6, 8)}`;

    // 4) 종목명 조회 (주식기본조회 호출)
    const symbol = await this.getDomesticStockName(stockCode);

    // 5) Finnhub recommendation 스타일로 반환
    return {
      buy,
      hold,
      sell,
      strongBuy: 0,
      strongSell: 0,
      period,
      symbol,
    };
  }

  // ========== Helpers ==========

  /** YYYYMMDD 포맷으로 날짜 변환 */
  private formatDate(date: Date): string {
    const y = date.getFullYear();
    const m = (date.getMonth() + 1).toString().padStart(2, '0');
    const d = date.getDate().toString().padStart(2, '0');
    return `${y}${m}${d}`;
  }

  private calcSMA(candles: DailyCandle[], period: number): number {
    if (candles.length < period) {
      throw new InternalServerErrorException(
        `이동평균 계산에 필요한 일수가 부족합니다. (필요: ${period}, 보유: ${candles.length})`,
      );
    }

    const slice = candles.slice(-period); // 최근 period개
    const sum = slice.reduce((acc, c) => acc + c.close, 0);
    return Number((sum / period).toFixed(2));
  }

  private calcRSI(candles: DailyCandle[], period = 14): number {
    if (candles.length <= period) {
      throw new InternalServerErrorException(
        `RSI 계산에 필요한 일수가 부족합니다. (필요: 최소 ${period + 1}일)`,
      );
    }

    const closes = candles.map((c) => c.close);

    let gainSum = 0;
    let lossSum = 0;

    // 초기 평균 (period일)
    for (let i = 1; i <= period; i++) {
      const delta = closes[i] - closes[i - 1];
      if (delta > 0) gainSum += delta;
      else lossSum -= delta; // delta < 0
    }

    let avgGain = gainSum / period;
    let avgLoss = lossSum / period;

    // 이후부터 Wilder smoothing
    for (let i = period + 1; i < closes.length; i++) {
      const delta = closes[i] - closes[i - 1];
      const gain = delta > 0 ? delta : 0;
      const loss = delta < 0 ? -delta : 0;

      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) {
      // 하락이 거의 없으면 RSI = 100
      return 100;
    }

    const rs = avgGain / avgLoss;
    const rsi = 100 - 100 / (1 + rs);
    return Number(rsi.toFixed(2));
  }

  private calcMomentum(
    candles: DailyCandle[],
    period = 14,
  ): { value: number; pct: number } {
    if (candles.length <= period) {
      throw new InternalServerErrorException(
        `모멘텀 계산에 필요한 일수가 부족합니다. (필요: 최소 ${period + 1}일)`,
      );
    }

    const latest = candles[candles.length - 1].close;
    const prev = candles[candles.length - 1 - period].close;

    const value = latest - prev;
    const pct = (latest / prev - 1) * 100;

    return {
      value: Number(value.toFixed(2)), // 단순 차이
      pct: Number(pct.toFixed(2)), // % 변화율
    };
  }

  /** 최근 한 달 전(30일 전) 날짜 문자열 'YYYYMMDD' */
  private getOneMonthAgoString(): string {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return this.formatDate(d);
  }

  /** Date → 'YYYYMMDD' 문자열로 변환 */
  private formatDateToYyyyMmDd(date: Date): string {
    const y = date.getFullYear();
    const m = (date.getMonth() + 1).toString().padStart(2, '0');
    const d = date.getDate().toString().padStart(2, '0');
    return `${y}${m}${d}`;
  }

  /** 최근 1개월(30일) 범위를 YYYYMMDD 기준으로 반환 */
  private getLastMonthRange(): { from: string; to: string } {
    const today = new Date();
    const to = this.formatDateToYyyyMmDd(today);

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);
    const from = this.formatDateToYyyyMmDd(fromDate);

    return { from, to };
  }

  // 날짜를 KIS 형식(00 + YYYYMMDD)으로 바꾸는 헬퍼 (필요 없으면 밖에서 그대로 넣어도 됨)
  private formatKisDate(date: string): string {
    // date: '20240513' 같은 8자리 문자열이라고 가정
    if (date.length === 8) {
      return `00${date}`;
    }
    // 이미 10자리면 그대로
    return date;
  }

  private async getDomesticStockName(stockCode: string): Promise<string> {
    const token = await this.getAccessToken();

    const url = `${this.baseUrl}/uapi/domestic-stock/v1/quotations/search-stock-info`;

    const params = {
      PRDT_TYPE_CD: '300', // 300: 주식/ETF/ETN/ELW
      PDNO: stockCode, // 종목코드 6자리
    };

    const headers = {
      authorization: `Bearer ${token}`,
      appkey: this.appKey,
      appsecret: this.appSecret,
      tr_id: 'CTPF1002R', // 주식기본조회 TR_ID
      custtype: 'P',
    };

    const { data } = await firstValueFrom(
      this.http.get(url, { headers, params }),
    );

    if (data.rt_cd && data.rt_cd !== '0') {
      throw new InternalServerErrorException(
        `KIS 주식기본조회 실패: ${data.msg1 ?? 'unknown error'}`,
      );
    }

    const output = data.output ?? {};
    // 상품약어명 > 상품명 순으로 시도, 둘 다 없으면 코드 리턴
    return output.prdt_abrv_name || output.prdt_name || stockCode;
  }
}
