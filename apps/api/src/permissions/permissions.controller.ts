import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { GrantPermissionDto } from "./dto/permission.dto";
import { PermissionsService, ValidatedGrant } from "./permissions.service";

@Controller("v1/permissions")
@UseGuards(ThrottlerGuard)
export class PermissionsController {
  constructor(private readonly permissions: PermissionsService) {}

  /**
   * Validate a permission grant and return the canonical permission id +
   * owner challenge (what the passkey signs). Authenticated: the caller proves
   * pid ownership; submission-time account binding is enforced by the relay path.
   */
  @Post("grants/validate")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  validateGrant(@Body() dto: GrantPermissionDto): ValidatedGrant {
    return this.permissions.validateGrant(dto);
  }

  /** Selectors a nonfinancial permission may never invoke (mirror of `_deniedSelector`). */
  @Get("denied-selectors")
  @HttpCode(HttpStatus.OK)
  deniedSelectors(): { selectors: string[] } {
    return { selectors: this.permissions.deniedSelectors() };
  }
}
