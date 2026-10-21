import { Body, Controller, ForbiddenException, Get, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { createHash, timingSafeEqual } from "node:crypto";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { UserTokenGuard } from "../common/user-token.guard";
import { RegisterSessionDto } from "./dto/session-key.dto";
import { SessionKeysService, ValidatedSessionGrant } from "./session-keys.service";

/** Expected `accountId` for a pid: `0x` + hex(sha256(lower(pid))) — same seed as pidToSeed32. */
export function expectedAccountIdHex(pid: string): string {
  return `0x${createHash("sha256").update(pid.trim().toLowerCase(), "utf8").digest("hex")}`;
}

function accountIdMatchesCaller(accountId: string, pid: string): boolean {
  const a = Buffer.from(accountId.toLowerCase(), "utf8");
  const b = Buffer.from(expectedAccountIdHex(pid).toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

@Controller("v1/session-keys")
@UseGuards(ThrottlerGuard)
export class SessionKeysController {
  constructor(private readonly sessionKeys: SessionKeysService) {}

  /**
   * Validate a session grant and return the canonical session address +
   * owner challenge (what the passkey signs). Authenticated: the caller proves
   * pid ownership. User-session-only (ANT-344 H3): `UserTokenGuard` rejects
   * machine tokens, so a leaked app secret cannot mint owner passkey
   * challenges. BOLA (ANT-285(d)): `dto.accountId` MUST equal sha256(caller
   * pid) — a caller cannot mint challenges for another identity's account.
   * The signed payload lands on-chain via the client, where `register_session`
   * enforces vault/authority binding; this inline check closes the
   * cross-pid challenge oracle one layer up (defense in depth).
   */
  @Post("grants/validate")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  validateGrant(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterSessionDto,
  ): Promise<ValidatedSessionGrant> {
    if (!accountIdMatchesCaller(dto.accountId, user.pid)) {
      throw new ForbiddenException("accountId does not belong to the caller");
    }
    return this.sessionKeys.validateGrant(dto);
  }

  /** Session bounds (mirror of the on-chain constants). */
  @Get("constants")
  @HttpCode(HttpStatus.OK)
  constants(): { maxTtlSecs: number; inactivitySecs: number; stateLen: number } {
    return this.sessionKeys.constants();
  }
}
