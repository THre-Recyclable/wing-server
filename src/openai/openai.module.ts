import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: OpenAI, // 🔹 토큰으로 OpenAI 클래스를 그대로 사용
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const apiKey = config.get<string>('OPENAI_API_KEY');
        if (!apiKey) {
          throw new Error('OPENAI_API_KEY is not set');
        }

        return new OpenAI({
          apiKey,
        });
      },
    },
  ],
  exports: [OpenAI], // 🔹 밖에서 OpenAI를 주입받을 수 있도록 export
})
export class OpenAiModule {}
