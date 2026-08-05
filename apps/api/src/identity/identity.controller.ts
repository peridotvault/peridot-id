import { Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, UseGuards } from "@nestjs/common";
import { Identity } from "@prisma/client";
import { CurrentUser, AuthenticatedUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { IdentityService } from "./identity.service";

@Controller("v1/identity")
export class IdentityController {
  constructor(private readonly identityService: IdentityService) {}

  @Get("me")
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser): Promise<Pick<Identity, "id" | "status" | "createdAt">> {
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
}
