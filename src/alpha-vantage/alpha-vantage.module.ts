import { Module } from '@nestjs/common';
import { AlphaVantageController } from './alpha-vantage.controller';
import { AlphaVantageService } from './alpha-vantage.service';
import { HttpModule } from '@nestjs/axios';

@Module({
  imports: [HttpModule],
  controllers: [AlphaVantageController],
  providers: [AlphaVantageService],
  exports: [AlphaVantageService],
})
export class AlphaVantageModule {}
