import {
  Controller,
  Post,
  Body,
  UseGuards,
  Get,
  Request,
  Query,
} from '@nestjs/common';
import { RegisterUserDTO } from './registerUser-dto';
import { AuthService } from './auth.service';
import { LoginDTO } from './login-dto';
import { CrawlersService } from 'src/crawlers/crawlers.service';
import { AuthGuard } from './auth.guard';
import { UnauthorizedException } from '@nestjs/common';
import {
  Node as NodeEntity,
  Edge as EdgeEntity,
  News as NewsEntity,
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
    description: 'News 배열',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', example: 77 },
          userID: { type: 'string', example: 'user-123' },
          startPoint: { type: 'string', example: '테슬라' },
          endPoint: { type: 'string', example: 'BYD' },
          pubDate: {
            type: 'string',
            example: 'Thu, 23 Oct 2025 09:29:00 +0900',
          },
          link: {
            type: 'string',
            example: 'https://n.news.naver.com/mnews/article/016/0002546020',
          },
          title: { type: 'string', example: '테슬라, 역대 최대 매출에도...' },
          description: { type: 'string', example: '기사 본문 요약본...' },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: '인증 필요' })
  async getUserNews(@Request() req): Promise<NewsEntity[]> {
    const id = req?.user?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new UnauthorizedException('유효한 사용자 id가 필요합니다.');
    }
    return this.authService.getNews(id);
  }

  /*
  @Get('news/by-keywords')
    async crawlByKeywords(@Query() dto: CollectNewsDTO) {
      return this.crawlersService.crawlNewsByKeywords(dto);
    }
  */
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Get('tree/by-keywords')
  @ApiOperation({
    summary:
      '키워드 기반으로 트리를 생성하고 DB에 저장합니다. 조회하려면 따로 get 요청을 보내야 합니다. 이전에 생성된 트리가 있다면 제거합니다.',
  })
  // 각 쿼리 파라미터 문서화 (GET + @Query는 DTO 예시 자동적용이 약함)
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
      default: ['BYD', '중국', '환율'], // UI 입력칸 프리필
    },
    style: 'form',
    explode: true, // ?subKeywords=BYD&subKeywords=중국 ...
  })
  @ApiQuery({ name: 'display', required: false, type: Number, example: 5 })
  @ApiQuery({ name: 'sort', required: false, type: String, example: 'sim' })
  @ApiQuery({ name: 'need', required: false, type: Number, example: 5 })
  @ApiOkResponse({
    description: '저장 요약',
    schema: {
      type: 'object',
      properties: {
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

    await this.crawlerService.clearUserGraph(id);
    return this.crawlerService.saveGraphForUser(dto, id);
  }
}
