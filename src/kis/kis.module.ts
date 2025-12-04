// src/kis/kis.module.ts
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { KisService } from './kis.service';
import { KisController } from './kis.controller';

@Module({
  imports: [
    ConfigModule,
    HttpModule.register({
      timeout: 5000,
    }),
  ],
  providers: [KisService],
  exports: [KisService],
  controllers: [KisController],
})
export class KisModule {}
