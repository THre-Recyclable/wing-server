// src/kis/kis.service.ts
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

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
}
