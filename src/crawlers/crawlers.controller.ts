import { Controller, Get, Query } from '@nestjs/common';
import { CrawlersService } from './crawlers.service';
import { NaverSearchDTO } from './naverSearchDTO';
import { CollectNewsDTO } from './collectNewsDTO';

@Controller('search')
export class CrawlersController {
  constructor(private readonly crawlersService: CrawlersService) {}

  /*
  @Get('news')
  async searchBlog(@Query() query: CollectNewsDTO) {
    return this.crawlersService.collectNaverMnewsLinks(query);
  }

  @Get('news/collect-and-crawl')
  async collectAndCrawl(@Query() query: CollectNewsDTO) {
    const collected = await this.crawlersService.collectNaverMnewsLinks(query);
    const enriched = await this.crawlersService.enrichCollectedWithBodies(
      collected.items,
    );
    return {
      ...collected,
      items: enriched,
    };
  }*/
  @Get('news/by-keywords')
  async crawlByKeywords(@Query() dto: CollectNewsDTO) {
    return this.crawlersService.crawlNewsByKeywords(dto);
  }
}
