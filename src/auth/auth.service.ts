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

  // 전체 Node 기준, 가장 많이 등장한 키워드 Top N
  async getTopKeywords(
    limit = 5,
  ): Promise<Array<{ name: string; count: number }>> {
    if (limit <= 0) {
      throw new BadRequestException('limit must be positive');
    }

    const rows = await this.prisma.node.groupBy({
      by: ['name'],
      _count: { id: true }, // _all 대신 id 기준으로 개수
      orderBy: {
        _count: {
          id: 'desc', // id 카운트 내림차순
        },
      },
      take: limit,
    });

    return rows.map((r) => ({
      name: r.name,
      count: (r._count as any).id, // r._count.id 사용
    }));
  }

  /**
   * 특정 그래프의 wing-score를 계산한다.
   *
   * wing-score 정의:
   *  - sentiment_label 이 'positive' => 엣지 값 +1
   *  - sentiment_label 이 'negative' => 엣지 값 -1
   *  - sentiment_label 이 'neutral'  => 엣지 값  0 (계산에서 제외)
   *
   *  - positive/negative 엣지에 대해 가중치 w_e = (해당 엣지에 속한 뉴스 개수) / (그래프 전체 뉴스 개수)
   *
   *  - 최종 점수:
   *      score_raw = ( Σ_e (edgeValue_e * w_e) ) / (전체 엣지 수)
   *      wingScore = trunc(score_raw * 100)   // 정수부분만 (음수도 0 방향으로 절삭)
   */
  async getWingScoreByGraph(
    user: string,
    graphId: number,
  ): Promise<{ graphId: number; wingScore: number }> {
    const userId = (user ?? '').trim();
    if (!userId) {
      throw new BadRequestException('user id is required');
    }
    if (!graphId || graphId <= 0) {
      throw new BadRequestException('graphId is required');
    }

    // 1) 그래프 존재 여부 검증
    const graph = await this.prisma.graph.findFirst({
      where: { id: graphId, userID: userId },
      select: { id: true },
    });
    if (!graph) {
      throw new BadRequestException('graph not found for this user');
    }

    // 2) 그래프의 모든 엣지 조회
    const edges = await this.prisma.edge.findMany({
      where: { userID: userId, graphId },
    });

    const totalEdges = edges.length;
    if (totalEdges === 0) {
      // 엣지가 없으면 wing-score는 0으로 간주
      return { graphId, wingScore: 0 };
    }

    // 3) 그래프에 속한 전체 뉴스 개수
    const totalNews = await this.prisma.news.count({
      where: { userID: userId, graphId },
    });

    if (totalNews === 0) {
      // 뉴스가 하나도 없으면 가중치는 모두 0이므로 wing-score = 0
      return { graphId, wingScore: 0 };
    }

    // 4) 엣지별 뉴스 개수를 groupBy로 한 번에 가져온다
    const newsGroups = await this.prisma.news.groupBy({
      by: ['startPoint', 'endPoint'],
      where: { userID: userId, graphId },
      _count: { id: true },
    });

    // (startPoint, endPoint) -> 뉴스 개수 매핑
    const newsCountMap = new Map<string, number>();
    for (const g of newsGroups) {
      const key = `${g.startPoint}::${g.endPoint}`;
      const count = (g._count as any).id ?? g._count?.id ?? 0;
      newsCountMap.set(key, count);
    }

    // 5) Σ_e (edgeValue * weight) 계산
    let sum = 0;

    for (const edge of edges) {
      const label = (edge.sentiment_label ?? '').toLowerCase().trim();

      let edgeValue = 0;
      if (label === 'positive') edgeValue = 1;
      else if (label === 'negative') edgeValue = -1;
      else if (label === 'neutral') edgeValue = 0;
      else edgeValue = 0; // 정의 외 값도 0 취급

      // neutral 이거나 정의 안 된 값은 계산에서 제외
      if (edgeValue === 0) {
        continue;
      }

      const key = `${edge.startPoint}::${edge.endPoint}`;
      const edgeNewsCount = newsCountMap.get(key) ?? 0;

      if (edgeNewsCount === 0) {
        // 뉴스가 하나도 없으면 가중치 0 → 기여도 0
        continue;
      }

      const weight = edgeNewsCount / totalNews;
      sum += edgeValue * weight;
    }

    // 6) 전체 엣지 수로 나누고, 100을 곱한 뒤 정수 부분만 취함
    const rawScore = sum / totalEdges; // 보통 -1 ~ +1 범위 (실제로는 더 좁음)
    const scaled = rawScore * 100;

    // 정수로 반올림: 3.4 -> 3, 3.5 -> 4, -3.4 -> -3, -3.5 -> -4
    const wingScore = Math.round(scaled);

    return { graphId, wingScore };
  }
}
