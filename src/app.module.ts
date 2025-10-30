import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CrawlersModule } from './crawlers/crawlers.module';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    HttpModule.register({
      timeout: 5000, // 5s 타임아웃
      maxRedirects: 0,
    }),
    CrawlersModule,
    AuthModule,
  ],
})
export class AppModule {}
