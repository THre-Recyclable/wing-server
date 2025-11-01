import { Module } from '@nestjs/common';
import { CrawlersController } from './crawlers.controller';
import { CrawlersService } from './crawlers.service';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from 'src/prisma.module';
@Module({
  imports: [HttpModule, PrismaModule],
  controllers: [CrawlersController],
  providers: [CrawlersService],
  exports: [CrawlersService],
})
export class CrawlersModule {}
