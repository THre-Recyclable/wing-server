import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // DTO에 없는 값 자동 제거
      forbidNonWhitelisted: true, // DTO에 없는 값 들어오면 400
      transform: true, // 쿼리스트링 -> DTO 타입 변환
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('WING server')
    .setDescription('The WING server API')
    .setVersion('1.0')
    .addTag('WING')
    .build();
  const documentFactory = () => SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, documentFactory);

  const whitelist = new Set<string>([
    'http://localhost:3000',
    'https://wing-five-phi.vercel.app',
  ]);

  app.enableCors({
    origin: (origin, callback) => {
      // 서버-서버 호출 또는 curl 등 Origin 없는 경우 허용(필요시 정책 수정)
      if (!origin) return callback(null, true);

      if (whitelist.has(origin)) return callback(null, true);

      // 필요하면 vercel 프리뷰 도메인 전체 허용 예시:
      // if (origin.endsWith('.vercel.app')) return callback(null, true);

      return callback(new Error(`CORS blocked: ${origin}`), false);
    },
    credentials: true, // 쿠키/인증 헤더 쓸 경우
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await app.listen(3000);
  console.log('http://127.0.0.1:3000/search/news?query=검색어');
}
bootstrap();
