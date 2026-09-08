import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, Length, Matches } from "class-validator";

/**
 * A bare http(s) origin: scheme + host + optional port, no path/query/fragment.
 * Trailing slashes are tolerated (normalized away) — anything else is rejected so
 * developers learn the model instead of silently storing something looser.
 */
export const ORIGIN_PATTERN = /^https?:\/\/[^/:?#]+(?::\d+)?\/?$/;

export class CreatePidAppDto {
  @IsString()
  @Length(1, 60)
  name!: string;

  /** Websites allowed to receive pid_codes and call the API (managed later too). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(ORIGIN_PATTERN, { each: true, message: "Each entry must be a bare http(s) origin, e.g. https://mygame.dev" })
  allowedOrigins?: string[];
}

export class UpdatePidAppDto {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(ORIGIN_PATTERN, { each: true, message: "Each entry must be a bare http(s) origin, e.g. https://mygame.dev" })
  allowedOrigins?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
