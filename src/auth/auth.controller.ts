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

@Controller('user')
export class AuthController {
  constructor(
    private authService: AuthService,
    private crawlerService: CrawlersService,
  ) {}

  @Post('/signup')
  async userRegister(
    @Body()
    registerUserDTO: RegisterUserDTO,
  ) {
    return await this.authService.signup(registerUserDTO);
  }

  @Post('/login')
  async login(
    @Body()
    loginDTO: LoginDTO,
  ) {
    return await this.authService.login(loginDTO);
  }

  @UseGuards(AuthGuard)
  @Get('/nodes')
  async getUserNodes(@Request() req): Promise<NodeEntity[]> {
    const id = req?.user?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new UnauthorizedException('유효한 사용자 id가 필요합니다.');
    }
    return this.authService.getNodes(id);
  }

  @UseGuards(AuthGuard)
  @Get('/edges')
  async getUserEdegs(@Request() req): Promise<EdgeEntity[]> {
    const id = req?.user?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new UnauthorizedException('유효한 사용자 id가 필요합니다.');
    }
    return this.authService.getEdges(id);
  }

  @UseGuards(AuthGuard)
  @Get('news')
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
  @Get('tree/by-keywords')
  async generateTree(@Query() dto: CollectNewsDTO, @Request() req) {
    const id = req?.user?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new UnauthorizedException('유효한 사용자 id가 필요합니다.');
    }

    return this.crawlerService.saveGraphForUser(dto, id);
  }
}
