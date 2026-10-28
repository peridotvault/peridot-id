// ANT-804 §6.1 / §6.2 contract DTOs (contract-first: shapes bind, see plan rev).
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

export const HANDLE_TAKEN = "HANDLE_TAKEN";
export const HANDLE_INVALID = "HANDLE_INVALID";

/** Idempotency keys are opaque client tokens (1..128 chars). */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_:.~-]{1,128}$/;

/** Claim a handle (ANT-804 D1, Opsi A — no reservation). Ticket rides the claim cookie. */
export class ClaimPidDto {
  @IsString()
  @MinLength(1, { message: "handle is required" })
  @MaxLength(64)
  handle!: string;

  @IsString()
  @Matches(IDEMPOTENCY_KEY_PATTERN, { message: "idempotencyKey must be 1-128 chars: letters, numbers, _:.~- " })
  idempotencyKey!: string;

  /**
   * PKCE S256 challenge passthrough (M5, ANT-802): forwarded to the claim flow
   * so the issued pid_code binds the wallet's challenge for public clients.
   */
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{43,128}$/, { message: "Invalid code_challenge" })
  codeChallenge?: string;
}

/** Takedown report intake (ANT-804 D2, §4.3 reactive thresholds). */
export class CreateReportDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  handle!: string;

  @IsIn(["trademark", "bulk", "other"], { message: "grounds must be trademark|bulk|other" })
  grounds!: string;

  @IsString()
  @MinLength(10, { message: "evidence must describe the claim (min 10 chars)" })
  @MaxLength(5000)
  evidence!: string;

  @IsString()
  @MinLength(3, { message: "reporterContact is required" })
  @MaxLength(320)
  reporterContact!: string;
}

/** Admin decision on a report (D2.4 remediation ordering). */
export class DecideReportDto {
  @IsIn(["keep", "release", "transfer"], { message: "decision must be keep|release|transfer" })
  decision!: string;

  @IsString()
  @MinLength(5, { message: "rationale is required (min 5 chars)" })
  @MaxLength(2000)
  rationale!: string;

  /** Required for transfer: the recipient pid (must already exist). */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  targetPid?: string;
}
