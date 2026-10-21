import { Controller, HttpCode, HttpStatus, NotFoundException, Post, UseGuards, Body } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { FiatLedgerService } from "./fiat-ledger.service";
import { TestCreditDto } from "./dto/faucet.dto";

/**
 * Sandbox faucet: instant test-money credit (ANT-287 FR-2).
 *
 * Authenticated (session cookie or machine Bearer — JwtAuthGuard accepts
 * both; read-scoped tokens are rejected for this POST by the guard).
 * Credits land through the same `fiat_issue` ledger path as corroborated
 * DOKU deposits, so balance/webhook behavior is identical — but no DOKU
 * call is made, so the faucet works even when DOKU sandbox is down.
 *
 * PRODUCTION MUST 404 (route absent, not 403 — no oracle). This holds at
 * two layers: `FiatModule` does not register this controller at all unless
 * `PID_FAUCET_ENABLED` is exactly `"true"`, and the handler re-checks the
 * same flag at runtime in case the env changed after boot.
 */
@Controller("v1/fiat")
@UseGuards(ThrottlerGuard)
export class FaucetController {
  constructor(
    private readonly ledger: FiatLedgerService,
    private readonly config: ConfigService,
  ) {}

  @Post("test-credit")
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  async testCredit(@CurrentUser() user: AuthenticatedUser, @Body() dto: TestCreditDto) {
    // Runtime re-check of the ANT-290 gate flag (module registration is the
    // primary gate; this covers env-changed-after-boot). Exact string match,
    // fail-closed — never DOKU_MODE (it defaults to sandbox: fail-open).
    if (this.config.get<string>("PID_FAUCET_ENABLED", "false") !== "true") {
      throw new NotFoundException("Not found");
    }
    const out = await this.ledger.mintTestCredit(user.pid, dto.amountMinor);
    return { ok: true, ...out };
  }
}
