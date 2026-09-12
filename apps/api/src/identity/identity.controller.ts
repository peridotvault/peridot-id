import { Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Res, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Identity } from "@prisma/client";
import { Response } from "express";
import { CurrentUser, AuthenticatedUser } from "../common/current-user.decorator";
import { clearAuthCookies } from "../common/cookies";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { IdentityService } from "./identity.service";

@Controller("v1/identity")
export class IdentityController {
  constructor(
    private readonly identityService: IdentityService,
    private readonly config: ConfigService,
  ) {}

  @Get("me")
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser): Promise<Pick<Identity, "id" | "status" | "role" | "createdAt">> {
    return this.identityService.getMe(user.identityId);
  }

  @Get("credentials")
  @UseGuards(JwtAuthGuard)
  listCredentials(@CurrentUser() user: AuthenticatedUser) {
    return this.identityService.listCredentials(user.identityId);
  }

  @Delete("credentials/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async unlinkCredential(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.identityService.unlinkCredential(user.identityId, id);
  }

  @Delete("me")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async deleteMe(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.identityService.deleteAccount(user.identityId);
    clearAuthCookies(res, this.config);
  }
}
