import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { AuthenticateFinishDto, RegisterFinishDto } from "./dto/credential.dto";
import {
  AuthenticateStartResult,
  AuthorityView,
  CredentialService,
  RegisterStartResult,
} from "./credential.service";

@Controller("v1/credentials")
@UseGuards(ThrottlerGuard)
export class CredentialController {
  constructor(private readonly credentialService: CredentialService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  list(@CurrentUser() user: AuthenticatedUser): Promise<AuthorityView[]> {
    return this.credentialService.list(user.identityId);
  }

  @Post("register/start")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  registerStart(@CurrentUser() user: AuthenticatedUser): Promise<RegisterStartResult> {
    return this.credentialService.registerStart(user.identityId);
  }

  @Post("register/finish")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  registerFinish(@CurrentUser() user: AuthenticatedUser, @Body() dto: RegisterFinishDto): Promise<AuthorityView> {
    return this.credentialService.registerFinish(user.identityId, {
      registrationId: dto.registrationId,
      credential: dto.credential as never,
      approval: dto.approval as never,
    });
  }

  @Post("authenticate/start")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  authenticateStart(@CurrentUser() user: AuthenticatedUser): Promise<AuthenticateStartResult> {
    return this.credentialService.authenticateStart(user.identityId);
  }

  @Post("authenticate/finish")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  authenticateFinish(@CurrentUser() user: AuthenticatedUser, @Body() dto: AuthenticateFinishDto): Promise<{ ok: true }> {
    return this.credentialService.authenticateFinish(user.identityId, {
      authenticationId: dto.authenticationId,
      credential: dto.credential as never,
    });
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  revoke(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string): Promise<AuthorityView> {
    return this.credentialService.revoke(user.identityId, id);
  }
}