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
}
