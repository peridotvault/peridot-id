import { IsOptional, IsString, IsUrl, Matches, MaxLength } from "class-validator";
import { ProfileUpdate } from "@peridot/types";
import { USERNAME_REGEX } from "../../common/username";

export class UpdateProfileDto implements ProfileUpdate {
  @IsOptional()
  @Matches(USERNAME_REGEX, { message: "username harus 3-20 karakter: huruf kecil, angka, underscore" })
  username?: string;

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
