//app.module.ts
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CrawlersModule } from './crawlers/crawlers.module';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma.module';

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
  ],
})
export class AppModule {}
