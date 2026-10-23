// ANT-456 — admin settings DTOs. All mutating routes are Role.admin
// (AdminGuard rejects app tokens); validation runs at the boundary:
// type, length, range, format, semantics (spec §5).

import { Type } from "class-transformer";
import { IsBoolean, IsDefined, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";

export class UpdateSettingDto {
  /** New value (semantic validation per key runs in the service). */
  @IsDefined()
  value!: unknown;

  /** Reason is mandatory and human-meaningful (10-500 chars, spec §5). */
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;

  /** Optimistic-lock guard: the version the admin opened. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class ListSettingsQuery {
  @IsString()
  @MaxLength(128)
  @IsOptional()
  prefix?: string;
}

export class SettingHistoryQuery {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  limit?: number;

  @IsString()
  @MaxLength(64)
  @IsOptional()
  cursor?: string;
}

export class RequestBackfillRunDto {
  /** Default true: preview + reconcile, zero XP-state writes. */
  @IsBoolean()
  @IsOptional()
  dryRun?: boolean;

  /**
   * Policy version number (e.g. "2") or policy id. Required when
   * dryRun=false; when omitted with dryRun=true the ACTIVE policy is previewed.
   */
  @IsString()
  @MaxLength(128)
  @IsOptional()
  policyVersion?: string;

  /** Resume cursor (a nextCursor from a previous run). */
  @IsString()
  @MaxLength(256)
  @IsOptional()
  cursor?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  @IsOptional()
  batchSize?: number;
}

export class ListBackfillRunsQuery {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number;
}
