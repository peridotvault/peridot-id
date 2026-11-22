import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from "class-validator";

const TASK_KEY = /^[a-z][a-z0-9_]{2,63}$/;

/**
 * Self-serve XP task DTOs (app owner). Deliberately small: no limits, no
 * cooldowns, no scope, no checker — the server forces those. `key` is the
 * event type the app reports.
 */
export class CreateAppXpTaskDto {
  @IsString()
  @Matches(TASK_KEY, { message: "key must match ^[a-z][a-z0-9_]{2,63}$" })
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
  @Max(1000)
  xpReward!: number;
}

export class UpdateAppXpTaskDto {
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
  @Max(1000)
  @IsOptional()
  xpReward?: number;

  @IsString()
  @IsOptional()
  status?: string;
}
