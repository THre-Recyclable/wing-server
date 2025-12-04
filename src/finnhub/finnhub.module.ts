// src/finnhub/finnhub.module.ts
import { Module } from '@nestjs/common';
import { FinnhubService } from './finnhub.service';
import { FinnhubController } from './finnhub.controller';

@Module({
  imports: [],
  controllers: [FinnhubController],
  providers: [FinnhubService],
  exports: [FinnhubService],
})
export class FinnhubModule {}
