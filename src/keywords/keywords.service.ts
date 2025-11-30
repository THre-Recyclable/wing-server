import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import OpenAI from 'openai';

type SubkeywordResult = {
  mainKeyword: string;
  subKeywords: string[];
};

@Injectable()
export class KeywordsService {
  constructor(private readonly openai: OpenAI) {}

  async suggestSubkeywords(
    mainKeyword: string,
    count = 8,
  ): Promise<SubkeywordResult> {
    const systemPrompt = `
너는 뉴스·증권 기사 검색용 키워드 추천 전문가다.

역할:
- 사용자가 입력한 메인 키워드를 중심으로, 함께 검색하면 유용한 서브 키워드를 추천한다.
- 이 키워드들은 한국어 뉴스/증권 기사 검색에 바로 쓸 수 있어야 한다.

요구사항:
- 모든 서브 키워드는 메인 키워드와 **높은 의미적 연관성**을 가져야 한다.
- 서브 키워드들끼리도 서로 연관성이 높은 하나의 클러스터가 되도록 구성한다.
- 각 서브 키워드는 1단어짜리 **명사구**로만 작성한다.
  - 예시: "젠슨황", "데이터센터"
- 기업/인물/국가/제품명/기술명 등, 실제 뉴스에서 함께 많이 언급될 법한 키워드를 우선한다.
- "관련", "이슈", "기사", "뉴스" 같은 불필요한 일반명사는 붙이지 않는다.
- 모든 출력은 한국어로 작성한다.

출력 형식:
- 반드시 내가 지정한 JSON 포맷에 **정확히 맞춰서만** 응답한다.
- JSON 외에 설명 문장, 주석, 마크다운, 자연어 문장을 절대 추가하지 않는다.
    `.trim();

    const userPrompt = `
메인 키워드: "${mainKeyword}"
원하는 서브 키워드 개수: ${count}

위 정보를 바탕으로, 다음 JSON 형식으로만 답변하라.

{
  "mainKeyword": "메인 키워드를 그대로 한 번 더 적기",
  "subKeywords": [
    "서브 키워드1",
    "서브 키워드2",
    "서브 키워드3"
  ]
}

규칙:
- "mainKeyword"에는 사용자가 입력한 메인 키워드를 그대로 다시 적는다.
- "subKeywords" 배열 길이는 **정확히 ${count}개**가 되도록 맞춘다.
- 배열 안에는 서브 키워드 문자열만 넣고, 다른 필드나 설명은 절대 추가하지 않는다.
    `.trim();

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-5.1',
      response_format: { type: 'json_object' },
      temperature: 0.3,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    const raw = completion.choices[0].message.content ?? '{}';

    let parsed: Partial<SubkeywordResult>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 혹시 JSON 깨지면 최소한의 fallback
      parsed = { mainKeyword, subKeywords: [] };
    }

    const result: SubkeywordResult = {
      mainKeyword: parsed.mainKeyword || mainKeyword,
      subKeywords: (parsed.subKeywords || []).slice(0, count),
    };

    return result;
  }
}
