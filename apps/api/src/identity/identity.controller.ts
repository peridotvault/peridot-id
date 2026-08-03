import { Controller, Get, UseGuards } from "@nestjs/common";
import { Identity } from "@prisma/client";
import { CurrentUser, AuthenticatedUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { IdentityService } from "./identity.service";

@Controller("v1/identity")
export class IdentityController {
  constructor(private readonly identityService: IdentityService) {}

  @Get("me")
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser): Promise<Pick<Identity, "id" | "createdAt">> {
    return this.identityService.getMe(user.identityId);
  }
}
