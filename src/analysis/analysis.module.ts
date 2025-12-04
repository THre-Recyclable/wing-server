// src/analysis/analysis.module.ts
import { Module } from '@nestjs/common';
import { AnalysisService } from './analysis.service';
import { AnalysisController } from './analysis.controller';
import { AlphaVantageModule } from 'src/alpha-vantage/alpha-vantage.module';
import { FinnhubModule } from 'src/finnhub/finnhub.module';
import { OpenAiModule } from 'src/openai/openai.module';

@Module({
  imports: [AlphaVantageModule, FinnhubModule, OpenAiModule],
  providers: [AnalysisService],
  controllers: [AnalysisController],
})
export class AnalysisModule {}
