import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from "class-validator";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AdminGuard } from "../common/admin.guard";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { UserTokenGuard } from "../common/user-token.guard";
import { CurrentUser, AuthenticatedUser } from "../common/current-user.decorator";
import { PidAppsService } from "./apps.service";
import { ProvidersService } from "./providers.service";

// https URL or same-origin path, raster image extension only (never SVG).
const IMAGE_URL = /^(https:\/\/[^\s?#]+|\/(?!\/)[^\s?#]*)\.(png|jpe?g|webp|gif|avif)(\?[^\s]*)?$/i;
const PROVIDER_CODE = /^[a-z][a-z0-9_]{1,31}$/;
const FAMILY_CODE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

class CreateProviderDto {
  @IsString() @Matches(PROVIDER_CODE, { message: "Invalid provider code" }) code!: string;
  @IsString() @Length(1, 80) name!: string;
  @IsIn(["web2", "web3"]) category!: "web2" | "web3";
  @IsIn(["oauth", "email_otp", "passkey", "wallet_signature"]) protocol!: string;
  @IsOptional() @IsString() @MaxLength(2048) @Matches(IMAGE_URL) imageUrl?: string | null;
}
class UpdateProviderDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsString() @MaxLength(2048) @Matches(IMAGE_URL) imageUrl?: string | null;
  @IsOptional() @IsBoolean() isAvailable?: boolean;
}
class OAuthConfigDto {
  @IsString() @Length(1, 200) clientId!: string;
  @IsOptional() @IsString() @Length(8, 500) clientSecret?: string;
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(100, { each: true }) scopes?: string[];
}
class ProviderChainsDto {
  @IsIn(["all", "selected"]) mode!: "all" | "selected";
  @IsArray() @ArrayUnique() @ArrayMaxSize(500) @IsUUID(undefined, { each: true }) chainIds!: string[];
}
class CreateFamilyDto {
  @IsString() @Matches(FAMILY_CODE, { message: "Invalid chain family code" }) code!: string;
}

export function loginPage(value?: string) {
  if (value !== undefined && (typeof value !== "string" || !/^[1-9]\d{0,4}$/.test(value))) throw new BadRequestException("Invalid page");
  return value ? Number(value) : 1;
}

function optionalDate(value: string | undefined, name: string): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`Invalid ${name}`);
  return date;
}

@Controller("v1")
@UseGuards(ThrottlerGuard)
export class ProvidersController {
  constructor(private readonly providers: ProvidersService, private readonly apps: PidAppsService) {}

  @Get("providers")
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  list() { return this.providers.list(); }

  @Get("admin/providers")
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  adminList() { return this.providers.adminList(); }

  @Get("admin/providers/:code")
  @UseGuards(JwtAuthGuard, AdminGuard)
  detail(@Param("code") code: string) { return this.providers.detail(code); }

  @Post("admin/providers")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  create(@CurrentUser() user: AuthenticatedUser, @Body() data: CreateProviderDto) {
    return this.providers.create(user.pid, data);
  }

  @Patch("admin/providers/:code")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  update(@CurrentUser() user: AuthenticatedUser, @Param("code") code: string, @Body() data: UpdateProviderDto) {
    return this.providers.update(user.pid, code, data);
  }

  @Get("admin/providers/:code/oauth")
  @UseGuards(JwtAuthGuard, AdminGuard)
  oauth(@Param("code") code: string) { return this.providers.oauthConfig(code); }

  @Put("admin/providers/:code/oauth")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  setOauth(@CurrentUser() user: AuthenticatedUser, @Param("code") code: string, @Body() data: OAuthConfigDto) {
    return this.providers.setOauthConfig(user.pid, code, data);
  }

  @Put("admin/providers/:code/chains/:namespace")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  chains(@CurrentUser() user: AuthenticatedUser, @Param("code") code: string, @Param("namespace") namespace: string, @Body() data: ProviderChainsDto) {
    return this.providers.chains(user.pid, code, namespace, data.mode, data.chainIds);
  }

  @Get("admin/chain-families")
  @UseGuards(JwtAuthGuard, AdminGuard)
  families() { return this.providers.chainFamilies(); }

  @Post("admin/chain-families")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  createFamily(@CurrentUser() user: AuthenticatedUser, @Body() data: CreateFamilyDto) {
    return this.providers.createFamily(user.pid, data.code);
  }

  @Get("apps/:id/logins")
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  async appLogins(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string, @Query("page") page?: string) {
    const n = loginPage(page);
    await this.apps.get(user.pid, id);
    return this.providers.logins(id, n);
  }

  @Get("admin/logins")
  @UseGuards(JwtAuthGuard, AdminGuard)
  adminLogins(
    @Query("page") page?: string,
    @Query("appId") appId?: string,
    @Query("pid") pid?: string,
    @Query("provider") providerCode?: string,
    @Query("evidence") evidence?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    if (appId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId)) {
      throw new BadRequestException("Invalid appId");
    }
    if (pid !== undefined && (pid.length > 100 || !/^[a-z0-9_]+@pid$/.test(pid))) throw new BadRequestException("Invalid pid");
    if (providerCode !== undefined && !PROVIDER_CODE.test(providerCode)) throw new BadRequestException("Invalid provider");
    if (evidence !== undefined && !["server", "client_selected", "unknown"].includes(evidence)) {
      throw new BadRequestException("Invalid evidence");
    }
    return this.providers.logins(undefined, loginPage(page), {
      ...(appId ? { appId } : {}),
      ...(pid ? { pid } : {}),
      ...(providerCode ? { providerCode } : {}),
      ...(evidence ? { evidence: evidence as "server" | "client_selected" | "unknown" } : {}),
      ...(optionalDate(from, "from") ? { from: optionalDate(from, "from") } : {}),
      ...(optionalDate(to, "to") ? { to: optionalDate(to, "to") } : {}),
    });
  }
}
