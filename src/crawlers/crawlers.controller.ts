import { Controller, Get, Query } from '@nestjs/common';
import { CrawlersService } from './crawlers.service';
import { CollectNewsDTO } from './collectNews-dto';

@Controller('search')
export class CrawlersController {
  constructor(private readonly crawlersService: CrawlersService) {}

  @Get('news/by-keywords')
  async crawlByKeywords(@Query() dto: CollectNewsDTO) {
    return this.crawlersService.crawlNewsByKeywords(dto);
  }

  @Get('investing')
  async getInvestingArticle(@Query('url') url: string) {
    return this.crawlersService.crawlInvestingArticle(url);
  }

  @Get('investing/list')
  async getInvestingList(@Query('q') query: string) {
    return this.crawlersService.collectInvestingAnalysisLinksFromApi(query, 20);
  }
}
