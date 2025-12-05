export class DomesticRecommendationDto {
  symbol: string; // 예: "삼성전자"
  period: string; // 예: "2025-12-01" (한 달 윈도우 시작일을 YYYY-MM-DD로)
  buy: number;
  hold: number;
  sell: number;
  strongBuy: number;
  strongSell: number;
}
