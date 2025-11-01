import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // DTO에 없는 값 자동 제거
      forbidNonWhitelisted: true, // DTO에 없는 값 들어오면 400
      transform: true, // 쿼리스트링 -> DTO 타입 변환
    }),
  );

  await app.listen(3000);
  console.log('http://127.0.0.1:3000/search/news?query=검색어');
}
bootstrap();
