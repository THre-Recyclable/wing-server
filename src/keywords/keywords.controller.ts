import { Body, Controller, Post } from '@nestjs/common';
import { KeywordsService } from './keywords.service';
import { SuggestSubkeywordsDto } from './dto/suggest-subkeywords.dto';
import { SubkeywordsResponseDto } from './dto/subkeywords-response.dto';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('Keywords')
@Controller('keywords')
export class KeywordsController {
  constructor(private readonly keywordsService: KeywordsService) {}

  @Post('subkeywords')
  @ApiOperation({
    summary: '메인 키워드 기반 서브 키워드 추천(GPT-5.1 사용)',
    description:
      '메인 키워드를 입력하면, 뉴스/증권 기사 검색에 함께 쓰기 좋은 연관 서브 키워드들을 추천합니다.',
  })
  @ApiBody({
    description: '메인 키워드 및 원하는 서브 키워드 개수',
    type: SuggestSubkeywordsDto,
  })
  @ApiResponse({
    status: 201,
    description: '성공적으로 서브 키워드를 추천한 경우',
    type: SubkeywordsResponseDto,
  })
  async suggestSubkeywords(
    @Body() dto: SuggestSubkeywordsDto,
  ): Promise<SubkeywordsResponseDto> {
    return this.keywordsService.suggestSubkeywords(dto.mainKeyword, dto.count);
  }
}
