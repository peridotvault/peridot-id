import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { RegisterSessionDto } from "./dto/session-key.dto";
import { SessionKeysService, ValidatedSessionGrant } from "./session-keys.service";

@Controller("v1/session-keys")
@UseGuards(ThrottlerGuard)
export class SessionKeysController {
  constructor(private readonly sessionKeys: SessionKeysService) {}

  /**
   * Validate a session grant and return the canonical session address +
   * owner challenge (what the passkey signs). Authenticated: the caller proves
   * pid ownership; submission-time vault binding is enforced by the relay path.
   */
  @Post("grants/validate")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  validateGrant(@Body() dto: RegisterSessionDto): Promise<ValidatedSessionGrant> {
    return this.sessionKeys.validateGrant(dto);
  }

  /** Session bounds (mirror of the on-chain constants). */
  @Get("constants")
  @HttpCode(HttpStatus.OK)
  constants(): { maxTtlSecs: number; inactivitySecs: number; stateLen: number } {
    return this.sessionKeys.constants();
  }
}
