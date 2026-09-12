// Admin chain-registry DTOs. Secrets never appear here — relayer keys and RPC
// API keys stay in env by design.
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from "class-validator";

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export class CreateChainDto {
  @IsIn(["solana", "eip155"])
  namespace!: string;

  @IsString()
  @MaxLength(88)
  reference!: string;

  @IsString()
  @MaxLength(64)
  name!: string;

  @IsString()
  @MaxLength(12)
  nativeSymbol!: string;

  @IsInt()
  @Min(0)
  @IsOptional()
  decimals?: number;

  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(5)
  @IsOptional()
  rpcUrls?: string[];

  @IsString()
  @MaxLength(256)
  @IsOptional()
  explorerUrl?: string;

  @IsString()
  @MaxLength(512)
  @IsOptional()
  logoUrl?: string;

  @IsBoolean()
  @IsOptional()
  isTestnet?: boolean;
}

export class UpdateChainDto {
  @IsString()
  @MaxLength(64)
  @IsOptional()
  name?: string;

  @IsString()
  @MaxLength(12)
  @IsOptional()
  nativeSymbol?: string;

  @IsInt()
  @Min(0)
  @IsOptional()
  decimals?: number;

  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(5)
  @IsOptional()
  rpcUrls?: string[];

  @IsString()
  @MaxLength(256)
  @IsOptional()
  explorerUrl?: string;

  @IsString()
  @MaxLength(512)
  @IsOptional()
  logoUrl?: string;

  @IsBoolean()
  @IsOptional()
  isTestnet?: boolean;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpsertContractDto {
  @IsIn(["factory", "account_implementation", "verifier", "paymaster"])
  type!: string;

  @IsString()
  @Matches(EVM_ADDRESS_RE, { message: "contract address must be 0x + 40 hex chars" })
  address!: string;

  @IsString()
  @MaxLength(32)
  @IsOptional()
  versionLabel?: string;

  @IsString()
  @MaxLength(88)
  @IsOptional()
  deployTxHash?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
