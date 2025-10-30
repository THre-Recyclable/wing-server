import { Module } from '@nestjs/common';
import { CrawlersController } from './crawlers.controller';
import { CrawlersService } from './crawlers.service';
import { HttpModule } from '@nestjs/axios';
@Module({
  imports: [HttpModule],
  controllers: [CrawlersController],
  providers: [CrawlersService],
})
export class CrawlersModule {}
