// src/keywords/keywords.module.ts
import { Module } from '@nestjs/common';
import { KeywordsService } from './keywords.service';
import { KeywordsController } from './keywords.controller';
import { OpenAiModule } from 'src/openai/openai.module';

@Module({
  imports: [OpenAiModule],
  providers: [KeywordsService],
  controllers: [KeywordsController],
})
export class KeywordsModule {}
