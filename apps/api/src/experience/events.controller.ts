import { Body, Controller, HttpCode, Post, Req, UnauthorizedException, UseFilters, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AppCredentialGuard, AuthedXpApp } from "./app-credential.guard";
import { SubmitEventDto } from "./events.dto";
import { EventsService, IntakeResult } from "./events.service";
import { IntakeThrottleAlertFilter } from "./intake-throttle.filter";
import { XP_INTAKE_APP_PID_THROTTLER, XP_INTAKE_APP_THROTTLER } from "./rate-limit";

/**
 * ANT-89 M3 (ANT-441) — application event-reporting API.
 *
 * POST /v1/experience/events authenticates the calling app's backend with
 * per-request client_id + client_secret (AppCredentialGuard — Tobias C2).
 * Cookie/JWT sessions are NEVER accepted here: this controller carries NO
 * JwtAuthGuard by design (locked by the C2 surface test; the intentional
 * allowlist entry in app-token-surface.spec.ts documents why this write
 * route is exempt from the user-token rule).
 *
 * Throttle tiers (Tobias F5): global default (100/min IP) outer bound,
 * per-app (60/min) and per-app+subject (30/min) inner tiers. 429s keep the
 * standard envelope and feed the suspicious-activity alert hook (F7).
 *
 * CALLERS: server-to-server only. Responses never oracle PID existence and
 * never carry secret material (F5/F9). Awarding is gated only by the runtime
 * kill-switches (xp.suspend.global / xp.suspend.<appId>).
 */
@Controller("v1/experience")
@UseGuards(ThrottlerGuard)
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Post("events")
  @HttpCode(200)
  @Throttle({
    default: { limit: 100, ttl: 60000 },
    [XP_INTAKE_APP_THROTTLER.name]: { limit: XP_INTAKE_APP_THROTTLER.limit, ttl: XP_INTAKE_APP_THROTTLER.ttl },
    [XP_INTAKE_APP_PID_THROTTLER.name]: { limit: XP_INTAKE_APP_PID_THROTTLER.limit, ttl: XP_INTAKE_APP_PID_THROTTLER.ttl },
  })
  @UseGuards(AppCredentialGuard)
  @UseFilters(IntakeThrottleAlertFilter)
  submit(
    @Body() dto: SubmitEventDto,
    @Req() req: { xpApp?: AuthedXpApp },
  ): Promise<IntakeResult> {
    const app = req.xpApp;
    // Defense in depth: the guard always sets this; never proceed anonymous.
    if (!app) throw new UnauthorizedException("Invalid client");
    return this.events.submitEvent(dto, app);
  }
}
