import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { LevelsService, LevelView } from "./levels.service";

/**
 * ANT-89 M1 — read-only Level API.
 *
 * Open to ALL authorized apps including unverified ones (JwtAuthGuard only —
 * no Verified/XP-permission check; those gate the M3 intake path, never
 * reads). Privacy: only live (non-deleted) identities resolve; anything
 * else is 404. Rate limiting comes from the global ThrottlerGuard default
 * (100/min), same as other reads.
 *
 * F1 read-authz rule (ANT-430 / plan rev 5 §13) — MVP-OPEN BY DESIGN, NOT
 * AN OVERSIGHT: unverified reads stay open through M1/M2. The GA decision
 * MUST be specified before M3 — per-user visibility default (who may see
 * whose level), per-app read caps, and enumeration throttling — so the M3
 * event pipeline does not inherit an open read by accident. Design note
 * only: no behavior change in M1.
 *
 * M1 hard gate: NO event-intake awarding here — that is M3 under release gates.
 */
@Controller("v1/users")
@UseGuards(ThrottlerGuard)
export class LevelsController {
  constructor(private readonly levels: LevelsService) {}

  @Get(":pid/level")
  @UseGuards(JwtAuthGuard)
  level(@Param("pid") pid: string): Promise<LevelView> {
    return this.levels.getLevelView(pid);
  }
}
