# wing-server

뉴스 기반 **키워드 그래프(Node/Edge/News)**와 투자 지표(**RSI / MOM / MA**)를 결합해, 이슈의 방향성과 강도를 **WING-Score(-100 ~ +100)**로 요약해 제공하는 NestJS 백엔드입니다.

## What it does
- 메인 키워드 입력 → 네이버 뉴스 크롤링 → (별도) AI 분석 결과를 그래프로 변환 → 사용자 단위 저장
- OpenAI / AlphaVantage / Finnhub / KIS 연동으로 주가·기술지표·애널리스트 의견·회사 뉴스 제공
- 그래프 기반 요약 지표 **WING-Score** 제공

## Key APIs (Analysis)
- GET /analysis/graphs/:graphId/symbol  
  그래프 노드 목록을 바탕으로 관련성이 높은 주식 심볼을 추론

- GET /analysis/price-ma?symbol=...&isDomestic=...  
  최근 1개월 종가 + MA20/MA60 시계열

- GET /analysis/rsi
- GET /analysis/momentum  
  해외: AlphaVantage 지표 사용 / 국내: KIS 일봉 기반 백엔드 자체 계산

- GET /analysis/recommendation  
  해외: Finnhub recommendation / 국내: KIS 기반 유사 포맷 요약

- GET /analysis/company-news  
  해외: Finnhub company news / 국내: 미지원

## WING-Score
뉴스가 적거나 그래프 품질이 낮으면 점수 절댓값이 자연스럽게 줄어 **0(neutral)** 쪽으로 수렴하도록 설계된, 그래프 기반 이슈 요약 점수입니다.

해석:
- +100 근처: 긍정 우세 + 데이터 충분
- -100 근처: 부정 우세 + 데이터 충분
- 0 근처: 혼재 또는 데이터 부족(불확실)

## Tech Stack
- TypeScript / Node.js
- NestJS + Prisma + PostgreSQL
- JWT 인증, bcrypt 해시
- Swagger
- External APIs: OpenAI, AlphaVantage, Finnhub, 한국투자증권(KIS)

## Run locally
1) Install
    npm install

2) Prisma (DB 설정 후)
    npx prisma generate
    npx prisma migrate dev

3) Start
    npm run start:dev

## Notes
- 실행 전 PostgreSQL 및 외부 API 키(OpenAI/AlphaVantage/Finnhub/KIS), 네이버 뉴스 크롤링 관련 설정이 필요합니다.
- 실행 후 Swagger 문서에서 전체 엔드포인트를 확인하세요.
