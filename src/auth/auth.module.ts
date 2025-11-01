//auth.module.ts
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PrismaModule } from 'src/prisma.module';
import { PrismaService } from 'src/prisma.service';
import { JwtModule } from '@nestjs/jwt';
import { jwtConstants } from './constants';
import { CrawlersModule } from 'src/crawlers/crawlers.module';

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: jwtConstants.secret,
      signOptions: { expiresIn: '60s' },
    }),
    PrismaModule,
    CrawlersModule,
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
