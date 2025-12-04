//app.module.ts
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CrawlersModule } from './crawlers/crawlers.module';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma.module';
import { OpenAiModule } from './openai/openai.module';
import { KeywordsModule } from './keywords/keywords.module';
import { FinnhubModule } from './finnhub/finnhub.module';
import { AlphaVantageModule } from './alpha-vantage/alpha-vantage.module';
import { AnalysisModule } from './analysis/analysis.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    HttpModule.register({
      timeout: 10000,
      maxRedirects: 0,
    }),
    CrawlersModule,
    AuthModule,
    PrismaModule,
    OpenAiModule,
    KeywordsModule,
    FinnhubModule,
    AlphaVantageModule,
    AnalysisModule,
  ],
})
export class AppModule {}
