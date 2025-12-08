//src/auth/auth.controller.ts
import {
  Controller,
  Post,
  Body,
  UseGuards,
  Get,
  Request,
  Query,
  ParseIntPipe,
  Param,
  Patch,
  Delete,
} from '@nestjs/common';
import { RegisterUserDTO } from './dto/registerUser-dto';
import { AuthService } from './auth.service';
import { LoginDTO } from './dto/login-dto';
import { CrawlersService } from 'src/crawlers/crawlers.service';
import { AuthGuard } from './auth.guard';
import { UnauthorizedException } from '@nestjs/common';
import {
  Node as NodeEntity,
  Edge as EdgeEntity,
  News as NewsEntity,
  Graph as GraphEntity,
} from '@prisma/client';
import { CollectNewsDTO } from 'src/crawlers/collectNews-dto';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiQuery,
  ApiUnauthorizedResponse,
  ApiBadRequestResponse,
  ApiExtraModels,
} from '@nestjs/swagger';
import { GetNewsQueryDto } from './dto/get-news-query.dto';
import { NewsListResponseDto } from './dto/news-list-response.dto';
import { GetNewsByGraphQueryDto } from './dto/get-news-by-graph-query.dto';
import { GetNewsByEdgeQueryDto } from './dto/get-news-by-edge-query.dto';
import { UpdateGraphNameDto } from './dto/update-graph-name.dto';

@ApiTags('User')
@Controller('user')
export class AuthController {
  constructor(
    private authService: AuthService,
    private crawlerService: CrawlersService,
  ) {}

  @Post('/signup')
  @ApiOperation({ summary: '회원 가입' })
  @ApiBody({ type: RegisterUserDTO })
  @ApiOkResponse({ description: '가입 성공' })
  @ApiBadRequestResponse({ description: '유효성 검증 실패' })
  @Post('/signup')
  async userRegister(
    @Body()
    registerUserDTO: RegisterUserDTO,
  ) {
    return await this.authService.signup(registerUserDTO);
  }

  @Post('/login')
  @ApiOperation({ summary: '로그인(토큰 발급)' })
  @ApiBody({ type: LoginDTO })
  @ApiOkResponse({
    description: '로그인 성공(JWT)',
    schema: {
      type: 'object',
      properties: {
        access_token: {
          type: 'string',
          example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        },
        id: {
          type: 'string',
          example: 'user1',
        },
      },
    },
  })
  async login(
    @Body()
    loginDTO: LoginDTO,
  ) {
    return await this.authService.login(loginDTO);
  }

  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Get('/nodes')
  @ApiOperation({ summary: '생성된 유저 트리에서 노드 정보를 가져옵니다.' })
  @ApiOkResponse({
    description: 'Node 배열',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', example: 1 },
          userID: { type: 'string', example: 'user-123' },
          name: { type: 'string', example: '테슬라' },
          weight: { type: 'number', format: 'float', example: 0.92 },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: '인증 필요' })
  async getUserNodes(@Request() req): Promise<NodeEntity[]> {
    const id = req?.user?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new UnauthorizedException('유효한 사용자 id가 필요합니다.');
    }
    return this.authService.getNodes(id);
  }

  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Get('/edges')
  @ApiOperation({
    summary:
      '생성된 유저 트리에서 엣지 목록을 가져옵니다. startPoint-endPoint 구분은 사실 큰 의미는 없습니다.',
  })
  @ApiOkResponse({
    description: 'Edge 배열',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', example: 10 },
          userID: { type: 'string', example: 'user-123' },
          startPoint: { type: 'string', example: '테슬라' },
          endPoint: { type: 'string', example: '중국' },
          weight: { type: 'number', format: 'float', example: 0.86 },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: '인증 필요' })
  async getUserEdegs(@Request() req): Promise<EdgeEntity[]> {
    const id = req?.user?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new UnauthorizedException('유효한 사용자 id가 필요합니다.');
    }
    return this.authService.getEdges(id);
  }

  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Get('news')
  @ApiOperation({
    summary:
      '생성된 유저 트리에서 뉴스 정보를 가져옵니다. 뉴스가 어느 엣지에 종속되는지는 startPoint-endPoint의 쌍으로 구분합니다. 같은 뉴스가 여러 엣지에 종속될 수 있습니다.',
  })
  @ApiOkResponse({
    description: '뉴스 목록 + 페이지네이션 메타',
    type: NewsListResponseDto,
  })
  @ApiUnauthorizedResponse({ description: '인증 필요' })
  async getNews(
    @Request() req,
    @Query() query: GetNewsQueryDto,
  ): Promise<NewsListResponseDto> {
    return this.authService.getNews(req?.user?.id, {
      take: query.take,
      cursor: query.cursor,
    });
  }

  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Get('tree/by-keywords')
  @ApiOperation({
    summary:
      '키워드 기반으로 새 그래프를 생성하고 DB에 저장합니다. (기존 그래프 유지, 조회하려면 따로 get 요청 필요)',
  })
  @ApiQuery({
    name: 'mainKeyword',
    required: true,
    type: String,
    example: '테슬라',
  })
  @ApiQuery({
    name: 'subKeywords',
    required: false,
    description: '반복 파라미터 또는 쉼표 구분 문자열 허용',
    schema: {
      type: 'array',
      items: { type: 'string' },
      default: ['BYD', '중국', '환율'],
    },
    style: 'form',
    explode: true,
  })
  @ApiOkResponse({
    description: '새로 생성된 그래프 요약',
    schema: {
      type: 'object',
      properties: {
        graphId: { type: 'integer', example: 42 },
        savedNodes: { type: 'integer', example: 5 },
        savedEdges: { type: 'integer', example: 10 },
        savedNews: { type: 'integer', example: 24 },
      },
    },
  })
  async generateTree(@Query() dto: CollectNewsDTO, @Request() req) {
    const id = req?.user?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new UnauthorizedException('유효한 사용자 id가 필요합니다.');
    }

    // 더 이상 전체 그래프 삭제 안 함
    // await this.crawlerService.clearUserGraph(id);

    const useCache =
      dto.useCache === undefined
        ? true // 기본값: 캐시 사용
        : String(dto.useCache).toLowerCase() !== 'false';

    const start = Date.now();

    // 새 그래프 하나 생성 + 저장
    const result = await this.crawlerService.saveGraphForUser(
      dto,
      id,
      useCache,
    );

    const elapsedMs = Date.now() - start;

    console.log(
      `[generateTree] user=${id}, mainKeyword=${dto.mainKeyword}, useCache=${useCache}, elapsedMs=${elapsedMs}ms`,
    );

    return result;
  }

  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Get('/graphs')
  @ApiOperation({ summary: '현재 로그인한 유저의 그래프 목록 조회' })
  @ApiOkResponse({
    description: '그래프 배열',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', example: 1 },
          userID: { type: 'string', example: 'user-123' },
          name: { type: 'string', example: '엔비디아 - 젠슨 황, 블랙웰' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: '인증 필요' })
  async getUserGraphs(@Request() req): Promise<GraphEntity[]> {
    const id = req?.user?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new UnauthorizedException('유효한 사용자 id가 필요합니다.');
    }
    return this.authService.getGraphs(id);
  }

  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Get('/nodes/by-graph')
  @ApiOperation({ summary: '특정 그래프에서 노드 정보를 가져옵니다.' })
  @ApiQuery({
    name: 'graphId',
    required: true,
    type: Number,
    example: 1,
    description: '조회할 그래프 ID',
  })
  @ApiOkResponse({
    description: 'Node 배열(그래프 단위)',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', example: 1 },
          userID: { type: 'string', example: 'user-123' },
          graphId: { type: 'integer', example: 1 },
          name: { type: 'string', example: '엔비디아' },
          weight: { type: 'number', format: 'float', example: 0.92 },
          kind: { type: 'string', example: 'MAIN' },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: '인증 필요' })
  async getUserNodesByGraph(
    @Request() req,
    @Query('graphId', ParseIntPipe) graphId: number,
  ): Promise<NodeEntity[]> {
    const id = req?.user?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new UnauthorizedException('유효한 사용자 id가 필요합니다.');
    }
    return this.authService.getNodesByGraph(id, graphId);
  }

  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Get('/edges/by-graph')
  @ApiOperation({
    summary: '특정 그래프에서 엣지 목록을 가져옵니다.',
  })
  @ApiQuery({
    name: 'graphId',
    required: true,
    type: Number,
    example: 1,
    description: '조회할 그래프 ID',
  })
  @ApiOkResponse({
    description: 'Edge 배열(그래프 단위)',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', example: 10 },
          userID: { type: 'string', example: 'user-123' },
          graphId: { type: 'integer', example: 1 },
          startPoint: { type: 'string', example: '엔비디아' },
          endPoint: { type: 'string', example: '젠슨 황' },
          weight: { type: 'number', format: 'float', example: 0.86 },
          sentiment_score: { type: 'number', format: 'float', example: 0.21 },
          sentiment_label: { type: 'string', example: 'positive' },
          collectedCount: { type: 'integer', example: 50 },
          totalEstimated: { type: 'integer', example: 53093 },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: '인증 필요' })
  async getUserEdgesByGraph(
    @Request() req,
    @Query('graphId', ParseIntPipe) graphId: number,
  ): Promise<EdgeEntity[]> {
    const id = req?.user?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new UnauthorizedException('유효한 사용자 id가 필요합니다.');
    }
    return this.authService.getEdgesByGraph(id, graphId);
  }

  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Get('/news/by-graph')
  @ApiOperation({
    summary:
      '특정 그래프에서 뉴스 정보를 가져옵니다. 뉴스가 어느 엣지에 종속되는지는 startPoint-endPoint 쌍으로 구분합니다.',
  })
  @ApiQuery({
    name: 'graphId',
    required: true,
    type: Number,
    example: 1,
    description: '조회할 그래프 ID',
  })
  @ApiOkResponse({
    description: '뉴스 목록 + 페이지네이션 메타(그래프 단위)',
    type: NewsListResponseDto,
  })
  @ApiUnauthorizedResponse({ description: '인증 필요' })
  async getNewsByGraph(
    @Request() req,
    @Query() query: GetNewsByGraphQueryDto, // take / cursor
  ): Promise<NewsListResponseDto> {
    const id = req?.user?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new UnauthorizedException('유효한 사용자 id가 필요합니다.');
    }

    return this.authService.getNewsByGraph(id, {
      graphId: query.graphId,
      take: query.take,
      cursor: query.cursor,
    });
  }

  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Get('/news/by-edge')
  @ApiOperation({
    summary:
      '특정 엣지에 속하는 뉴스만 조회합니다. startPoint/endPoint 방향이 뒤바뀐 경우도 모두 포함됩니다. 커서 및 페이지네이션 포함',
  })
  @ApiOkResponse({
    description: '뉴스 목록 + 페이지네이션 메타(엣지 단위)',
    type: NewsListResponseDto,
  })
  @ApiUnauthorizedResponse({ description: '인증 필요' })
  async getNewsByEdge(
    @Request() req,
    @Query() query: GetNewsByEdgeQueryDto,
  ): Promise<NewsListResponseDto> {
    const id = req?.user?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new UnauthorizedException('유효한 사용자 id가 필요합니다.');
    }

    return this.authService.getNewsByEdge(id, {
      graphId: query.graphId,
      startPoint: query.startPoint,
      endPoint: query.endPoint,
      take: query.take,
      cursor: query.cursor,
    });
  }

  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Patch('graphs/:graphId')
  @ApiOperation({
    summary: '특정 그래프의 이름을 변경합니다.',
  })
  @ApiOkResponse({
    description: '이름이 변경된 그래프',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', example: 42 },
        userID: { type: 'string', example: 'user-123' },
        name: {
          type: 'string',
          example: '엔비디아 - 젠슨 황, TSMC, HBM',
        },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: '인증 필요' })
  async renameGraph(
    @Request() req,
    @Param('graphId', ParseIntPipe) graphId: number,
    @Body() dto: UpdateGraphNameDto,
  ) {
    const id = req?.user?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new UnauthorizedException('유효한 사용자 id가 필요합니다.');
    }

    return this.crawlerService.renameGraphForUser(id, graphId, dto.name);
  }

  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Delete('graphs/:graphId')
  @ApiOperation({
    summary:
      '특정 그래프를 삭제합니다. 해당 그래프에 속한 노드/엣지/뉴스도 함께 삭제됩니다.',
  })
  @ApiOkResponse({
    description: '삭제 결과 요약',
    schema: {
      type: 'object',
      properties: {
        graphId: { type: 'integer', example: 42 },
        deletedNews: { type: 'integer', example: 24 },
        deletedEdges: { type: 'integer', example: 10 },
        deletedNodes: { type: 'integer', example: 5 },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: '인증 필요' })
  async deleteGraph(
    @Request() req,
    @Param('graphId', ParseIntPipe) graphId: number,
  ) {
    const id = req?.user?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new UnauthorizedException('유효한 사용자 id가 필요합니다.');
    }

    return this.crawlerService.deleteGraphForUser(id, graphId);
  }

  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Get('top-keywords')
  @ApiOperation({
    summary: '전체 그래프에서 가장 많이 등장한 키워드 Top 5를 반환합니다.',
    description:
      'Node 테이블에서 name별 등장 횟수를 집계하여 상위 5개 키워드를 제공합니다.',
  })
  @ApiOkResponse({
    description: '가장 많이 등장한 키워드 목록',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', example: '엔비디아' },
          count: { type: 'integer', example: 15 },
        },
      },
      example: [
        { name: '엔비디아', count: 15 },
        { name: 'AI', count: 9 },
        { name: 'TSMC', count: 7 },
        { name: '테슬라', count: 6 },
        { name: 'HBM', count: 5 },
      ],
    },
  })
  @ApiUnauthorizedResponse({ description: '인증 필요' })
  async getTopKeywords() {
    return this.authService.getTopKeywords(5);
  }

  @Get(':graphId/wing-score')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: '특정 그래프의 wing-score(호재 강도 점수)를 계산합니다.',
    description:
      '그래프 내 엣지들의 sentiment_label 및 뉴스 개수를 기반으로 0~±100 범위의 wing-score를 계산합니다.',
  })
  @ApiOkResponse({
    description: 'wing-score 결과',
    schema: {
      type: 'object',
      properties: {
        graphId: { type: 'integer', example: 3 },
        wingScore: {
          type: 'integer',
          example: 17,
          description:
            '그래프의 호재 강도를 나타내는 정수 점수 (대략 -100 ~ +100)',
        },
      },
      example: {
        graphId: 3,
        wingScore: 17,
      },
    },
  })
  @ApiUnauthorizedResponse({ description: '인증 필요' })
  async getWingScore(
    @Request() req,
    @Param('graphId', ParseIntPipe) graphId: number,
  ) {
    const id = req?.user?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new UnauthorizedException('유효한 사용자 id가 필요합니다.');
    }
    return this.authService.getWingScoreByGraph(id, graphId);
  }
}
