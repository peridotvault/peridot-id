import { IsOptional, IsString, IsUrl, MaxLength } from "class-validator";
import { ProfileUpdate } from "@peridot/types";

export class UpdateProfileDto implements ProfileUpdate {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  displayName?: string | null;

  @IsOptional()
  @IsUrl()
  avatarUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  locale?: string | null;
}
