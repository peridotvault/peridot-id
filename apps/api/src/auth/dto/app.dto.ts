import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsOptional, IsString, IsUrl, Length } from "class-validator";

export class CreatePidAppDto {
  @IsString()
  @Length(1, 60)
  name!: string;

  /** Redirect URIs PeridotID may return pid_codes to (http/https only). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsUrl({ require_protocol: true, protocols: ["http", "https"] }, { each: true })
  redirectUris!: string[];
}

export class UpdatePidAppDto {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsUrl({ require_protocol: true, protocols: ["http", "https"] }, { each: true })
  redirectUris?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
