import { IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

/**
 * ANT-89 M3 (ANT-441) — POST /v1/experience/events intake DTO (server-to-server).
 *
 * Wire uses snake_case (plan rev 5 §6). Authentication travels in the body
 * alongside the event (same envelope convention as the existing AppTokenDto
 * client-credentials flow): `client_id` + `client_secret` are verified per
 * request by AppCredentialGuard — cookies/JWT sessions are NEVER accepted
 * on this route (Tobias C2).
 *
 * Tobias F6: this DTO contains NO xp/amount field. Any client-supplied XP
 * value is stripped by the global ValidationPipe (whitelist) and can never
 * reach the pipeline — awards use the server-side XpTask.xpReward only.
 * A regression test locks the field list (no `xp`/`amount`/`reward` keys).
 */
export class SubmitEventDto {
  /** Public app identifier (`pidapp_*`). */
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  client_id!: string;

  /** Confidential-client secret (`pidsk_*`; never logged, never echoed). */
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  client_secret!: string;

  /** App-scoped idempotency key: dedup is (appId, eventId) — ANT-430 C1. */
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  event_id!: string;

  /** Subject user PID (`<handle>@pid`). Existence is never oracled (F5). */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  user_id!: string;

  /** Must be format-valid (400 otherwise) AND on the app's approved list. */
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{2,63}$/, { message: "event_type must match ^[a-z][a-z0-9_]{2,63}$" })
  @MaxLength(64)
  event_type!: string;

  /** Checker input (e.g. achievement/resource reference). Optional. */
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  @IsOptional()
  resource_id?: string;
}
