// ANT-89 M2 — admin experience DTOs. All mutating routes are Role.admin
// (AdminGuard rejects app tokens); validation runs at the boundary:
// type, length, range, format, semantics.
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export const SECOND_PERSON_MIN_REASON = 10;

function reasonField(optional = true) {
  return { optional };
}
export { reasonField };

export class CreatePolicyDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  base?: number;

  @IsOptional()
  @Type(() => Number)
  exponent?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  maxLevel?: number;
}

export class MaterializePolicyDto {
  /** Optional per-level cumulative-XP overrides { level: xp }. Overrides win over the formula. */
  @IsOptional()
  overrides?: Record<string, number>;
}

export class ActivatePolicyDto {
  /** Second-person confirm: a DIFFERENT admin pid approving this activation. */
  @IsString()
  @MaxLength(128)
  @IsOptional()
  confirmedBy?: string;

  /** Mandatory justification when no second-person confirm is supplied. */
  @IsString()
  @MinLength(SECOND_PERSON_MIN_REASON)
  @MaxLength(512)
  @IsOptional()
  reason?: string;
}

export class CreateTaskDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{2,63}$/, { message: "key must match ^[a-z][a-z0-9_]{2,63}$" })
  key!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsString()
  @MaxLength(2000)
  @IsOptional()
  description?: string;

  @IsInt()
  @Min(1)
  @Max(100000)
  xpReward!: number;

  @IsIn(["once", "daily", "weekly", "monthly", "unlimited"])
  @IsOptional()
  recurring?: string;

  @IsInt()
  @Min(1)
  @Max(1000000)
  @IsOptional()
  lifetimeLimit?: number;

  @IsInt()
  @Min(1)
  @Max(100000)
  @IsOptional()
  dailyLimit?: number;

  @IsInt()
  @Min(1)
  @Max(100000)
  @IsOptional()
  weeklyLimit?: number;

  @IsInt()
  @Min(1)
  @Max(100000)
  @IsOptional()
  monthlyLimit?: number;

  @IsInt()
  @Min(0)
  @Max(31536000)
  @IsOptional()
  cooldownSecs?: number;

  @IsDateString()
  @IsOptional()
  availableFrom?: string;

  @IsDateString()
  @IsOptional()
  availableUntil?: string;

  @IsIn(["internal_state", "backend_check"])
  @IsOptional()
  verificationType?: string;

  @IsString()
  @MaxLength(128)
  @IsOptional()
  verificationChecker?: string;

  @IsString()
  @MaxLength(128)
  @IsOptional()
  scopeAppId?: string;
}

export class UpdateTaskDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @IsOptional()
  name?: string;

  @IsString()
  @MaxLength(2000)
  @IsOptional()
  description?: string;

  @IsInt()
  @Min(1)
  @Max(100000)
  @IsOptional()
  xpReward?: number;

  @IsIn(["once", "daily", "weekly", "monthly", "unlimited"])
  @IsOptional()
  recurring?: string;

  @IsInt()
  @Min(1)
  @Max(1000000)
  @IsOptional()
  lifetimeLimit?: number;

  @IsInt()
  @Min(1)
  @Max(100000)
  @IsOptional()
  dailyLimit?: number;

  @IsInt()
  @Min(1)
  @Max(100000)
  @IsOptional()
  weeklyLimit?: number;

  @IsInt()
  @Min(1)
  @Max(100000)
  @IsOptional()
  monthlyLimit?: number;

  @IsInt()
  @Min(0)
  @Max(31536000)
  @IsOptional()
  cooldownSecs?: number;

  @IsDateString()
  @IsOptional()
  availableFrom?: string;

  @IsOptional()
  availableUntil?: string | null;

  @IsIn(["internal_state", "backend_check"])
  @IsOptional()
  verificationType?: string;

  @IsOptional()
  verificationChecker?: string | null;

  @IsOptional()
  scopeAppId?: string | null;

  @IsIn(["draft", "active", "disabled", "archived"])
  @IsOptional()
  status?: string;
}

/** F3 second-person-or-justification envelope shared by xp/quota/policy grants. */
export class GrantEnvelopeDto {
  @IsString()
  @MaxLength(128)
  @IsOptional()
  confirmedBy?: string;

  @IsString()
  @MinLength(SECOND_PERSON_MIN_REASON)
  @MaxLength(512)
  @IsOptional()
  reason?: string;
}

export class SetXpPermissionDto extends GrantEnvelopeDto {
  @IsBoolean()
  xpEnabled!: boolean;

  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  approvedEventTypes!: string[];
}

export class UpsertQuotaDto extends GrantEnvelopeDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000000)
  dailyCap?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000000)
  weeklyCap?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000000)
  monthlyCap?: number | null;

  @IsBoolean()
  @IsOptional()
  suspended?: boolean;

  @IsString()
  @MaxLength(512)
  @IsOptional()
  suspendReason?: string | null;
}

export class SuspendAppDto {
  @IsBoolean()
  suspended!: boolean;

  @IsString()
  @MaxLength(512)
  @IsOptional()
  suspendReason?: string;

  @IsString()
  @MinLength(SECOND_PERSON_MIN_REASON)
  @MaxLength(512)
  @IsOptional()
  reason?: string;
}

export class AdjustXpDto {
  @IsString()
  @MaxLength(128)
  pid!: string;

  @IsInt()
  @Min(1)
  @Max(1000000)
  deltaXp!: number;

  @IsString()
  @MinLength(3)
  @MaxLength(512)
  reason!: string;
}

export class ReverseXpDto {
  @IsString()
  @MaxLength(128)
  pid!: string;

  @IsInt()
  @Min(1)
  @Max(1000000)
  amount!: number;

  @IsString()
  @MinLength(3)
  @MaxLength(512)
  reason!: string;

  /** Optional link to the original ledger entry being reversed (audit aid). */
  @IsString()
  @MaxLength(128)
  @IsOptional()
  originalEntryId?: string;
}

export class ReviewSuspiciousDto {
  @IsBoolean()
  reviewed!: boolean;

  @IsString()
  @MaxLength(512)
  @IsOptional()
  note?: string;
}
