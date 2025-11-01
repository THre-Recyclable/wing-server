import { Injectable, UnauthorizedException } from '@nestjs/common';
import { RegisterUserDTO } from './registerUser-dto';
import { SignUpResponse } from './user';
import * as bcrypt from 'bcrypt';
import { PrismaService } from 'src/prisma.service';
import { LoginDTO } from './login-dto';
import { JwtService } from '@nestjs/jwt';
import { access } from 'fs';
import { BadRequestException } from '@nestjs/common';
import {
  Node as NodeEntity,
  Edge as EdgeEntity,
  News as NewsEntity,
} from '@prisma/client';

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

  async login(loginDTO: LoginDTO): Promise<{ accessToken: string }> {
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

    return { accessToken };
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

  async getNews(user: string): Promise<NewsEntity[]> {
    const userId = (user ?? '').trim();
    if (!userId) {
      throw new BadRequestException('user id is required');
    }

    return this.prisma.news.findMany({
      where: { userID: userId },
    });
  }
}
