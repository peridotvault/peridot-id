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
   * pid ownership. No server submission path exists — the owner-signed payload
   * is the pid→account binding (account + chainId are part of the signed
   * payload); any future relay must re-check pid ownership before forwarding
   * (see PermissionsService).
   */
  @Post("grants/validate")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  validateGrant(@Body() dto: GrantPermissionDto): ValidatedGrant {
    return this.permissions.validateGrant(dto);
  }

  /**
   * Selectors a nonfinancial permission may never invoke (mirror of `_deniedSelector`).
   * Deliberately public (ANT-284): the set is client-side hygiene, not a
   * secret — it mirrors on-chain `grantPermission` checks plus the
   * `@peridotvault/pid-evm` SDK constants, all readable by anyone. Gating it
   * behind auth would break pre-login consent screens with zero security
   * gain; the enforcement point is `validateGrant` + the contract, never
   * obscurity of this list.
   */
  @Get("denied-selectors")
  @HttpCode(HttpStatus.OK)
  deniedSelectors(): { selectors: string[] } {
    return { selectors: this.permissions.deniedSelectors() };
  }
}
