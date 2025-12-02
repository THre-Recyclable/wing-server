//src/auth/auth.service.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { RegisterUserDTO } from './dto/registerUser-dto';
import { SignUpResponse } from './user';
import * as bcrypt from 'bcrypt';
import { PrismaService } from 'src/prisma.service';
import { LoginDTO } from './dto/login-dto';
import { JwtService } from '@nestjs/jwt';
import { access } from 'fs';
import { BadRequestException } from '@nestjs/common';
import {
  Node as NodeEntity,
  Edge as EdgeEntity,
  News as NewsEntity,
  Graph as GraphEntity,
} from '@prisma/client';
import { NewsListResponseDto } from './dto/news-list-response.dto';

class User {
  id: string;
  password: string;
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async signup(payload: RegisterUserDTO): Promise<SignUpResponse> {
    const hash = await this.encryptPassword(payload.password, 10);
    payload.password = hash;
    return await this.prisma.user.create({
      data: payload,
      select: {
        id: true,
      },
    });
  }

  async encryptPassword(plainText, saltRounds) {
    return await bcrypt.hash(plainText, saltRounds);
  }

  async decryptPassword(plainText, hash) {
    return await bcrypt.compare(plainText, hash);
  }

  async login(
    loginDTO: LoginDTO,
  ): Promise<{ accessToken: string; id: string }> {
    const user = await this.prisma.user.findFirst({
      where: {
        id: loginDTO.id,
      },
    });

    if (!user) {
      throw new UnauthorizedException();
    }

    const isMatched = await this.decryptPassword(
      loginDTO.password,
      user.password,
    );

    if (!isMatched) {
      throw new UnauthorizedException('Invalid password');
    }

    const accessToken = await this.jwtService.signAsync(
      {
        id: user.id,
      },
      { expiresIn: '1d' },
    );

    return { accessToken, id: user.id };
  }

  async getNodes(user: string): Promise<NodeEntity[]> {
    const userId = (user ?? '').trim();
    if (!userId) {
      throw new BadRequestException('user id is required');
    }

    return this.prisma.node.findMany({
      where: { userID: userId },
    });
  }

  async getEdges(user: string): Promise<EdgeEntity[]> {
    const userId = (user ?? '').trim();
    if (!userId) {
      throw new BadRequestException('user id is required');
    }

    return this.prisma.edge.findMany({
      where: { userID: userId },
    });
  }

  async getNews(
    user: string,
    options?: { take?: number; cursor?: number },
  ): Promise<NewsListResponseDto> {
    const userId = (user ?? '').trim();
    if (!userId) {
      throw new BadRequestException('user id is required');
    }

    const take = options?.take ?? 20;
    const cursor = options?.cursor;

    const rawItems = await this.prisma.news.findMany({
      where: { userID: userId },
      orderBy: [
        { pubDate: 'desc' }, // 최신 뉴스 먼저
        { id: 'desc' }, // pubDate 같을 때 id 순으로 고정
      ],
      take: take + 1,
      ...(cursor
        ? {
            cursor: { id: cursor }, // PK int
            skip: 1,
          }
        : {}),
    });

    const hasNextPage = rawItems.length > take;
    const items = hasNextPage ? rawItems.slice(0, take) : rawItems;

    const nextCursor = hasNextPage
      ? (items[items.length - 1]?.id ?? null)
      : null;

    return {
      items,
      meta: {
        hasNextPage,
        nextCursor,
      },
    };
  }

  async getGraphs(user: string): Promise<GraphEntity[]> {
    const userId = (user ?? '').trim();
    if (!userId) {
      throw new BadRequestException('user id is required');
    }

    return this.prisma.graph.findMany({
      where: { userID: userId },
      orderBy: { id: 'desc' }, // 최신 그래프 먼저
    });
  }

  // 특정 그래프의 Node 목록
  async getNodesByGraph(user: string, graphId: number): Promise<NodeEntity[]> {
    const userId = (user ?? '').trim();
    if (!userId) {
      throw new BadRequestException('user id is required');
    }
    if (!graphId || graphId <= 0) {
      throw new BadRequestException('graphId is required');
    }

    return this.prisma.node.findMany({
      where: { userID: userId, graphId },
      orderBy: [
        { kind: 'asc' }, // MAIN, SUB 순서 등 enum 정의에 따라
        { weight: 'desc' },
      ],
    });
  }

  // 특정 그래프의 Edge 목록
  async getEdgesByGraph(user: string, graphId: number): Promise<EdgeEntity[]> {
    const userId = (user ?? '').trim();
    if (!userId) {
      throw new BadRequestException('user id is required');
    }
    if (!graphId || graphId <= 0) {
      throw new BadRequestException('graphId is required');
    }

    return this.prisma.edge.findMany({
      where: { userID: userId, graphId },
      orderBy: [{ weight: 'desc' }, { id: 'asc' }],
    });
  }

  // 특정 그래프의 News 목록 (페이지네이션 포함)
  async getNewsByGraph(
    user: string,
    options: { graphId: number; take?: number; cursor?: number },
  ): Promise<NewsListResponseDto> {
    const userId = (user ?? '').trim();
    if (!userId) {
      throw new BadRequestException('user id is required');
    }

    const graphId = options?.graphId;
    if (!graphId || graphId <= 0) {
      throw new BadRequestException('graphId is required');
    }

    const take = options?.take ?? 20;
    const cursor = options?.cursor;

    const rawItems = await this.prisma.news.findMany({
      where: { userID: userId, graphId },
      orderBy: [{ pubDate: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(cursor
        ? {
            cursor: { id: cursor },
            skip: 1,
          }
        : {}),
    });

    const hasNextPage = rawItems.length > take;
    const items = hasNextPage ? rawItems.slice(0, take) : rawItems;

    const nextCursor = hasNextPage
      ? (items[items.length - 1]?.id ?? null)
      : null;

    return {
      items,
      meta: {
        hasNextPage,
        nextCursor,
      },
    };
  }

  async getNewsByEdge(
    user: string,
    options: {
      graphId: number;
      startPoint: string;
      endPoint: string;
      take?: number;
      cursor?: number;
    },
  ): Promise<NewsListResponseDto> {
    const userId = (user ?? '').trim();
    if (!userId) {
      throw new BadRequestException('user id is required');
    }

    const graphId = options.graphId;
    const start = (options.startPoint ?? '').trim();
    const end = (options.endPoint ?? '').trim();

    if (!graphId || graphId <= 0) {
      throw new BadRequestException('graphId is required');
    }
    if (!start || !end) {
      throw new BadRequestException('startPoint and endPoint are required');
    }

    const take = options.take ?? 20;
    const cursor = options.cursor;

    const whereBase = {
      userID: userId,
      graphId,
      OR: [
        { startPoint: start, endPoint: end }, // 정방향
        { startPoint: end, endPoint: start }, // 역방향
      ],
    };

    const rawItems = await this.prisma.news.findMany({
      where: whereBase,
      orderBy: [{ pubDate: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(cursor
        ? {
            cursor: { id: cursor },
            skip: 1,
          }
        : {}),
    });

    const hasNextPage = rawItems.length > take;
    const items = hasNextPage ? rawItems.slice(0, take) : rawItems;

    const nextCursor = hasNextPage
      ? (items[items.length - 1]?.id ?? null)
      : null;

    return {
      items,
      meta: {
        hasNextPage,
        nextCursor,
      },
    };
  }
}
