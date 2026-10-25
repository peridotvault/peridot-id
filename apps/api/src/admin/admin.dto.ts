// Admin chain-registry DTOs. Secrets never appear in RESPONSES — the EVM
// relayer key (EvmRelayerKey, dashboard-managed since ANT-193) is write-only
// via the admin API and read server-side only. Other relayer keys and RPC API
// keys stay in env by design.
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

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

export class VerifyAppDto {
  @IsBoolean()
  verified!: boolean;
}

/** Write-only EVM auto-deploy relayer key (0x-prefixed 32-byte hex). Never returned by any endpoint. */
export class SetEvmRelayerDto {
  @IsString()
  @Matches(/^0x[0-9a-fA-F]{64}$/, { message: "relayer secret must be 0x-prefixed 32-byte hex" })
  secret!: string;
}

export class UpsertContractDto {
  @IsIn(["factory", "account_implementation", "verifier", "paymaster", "program"])
  type!: string;

  @IsString()
  @Matches(/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/, {
    message: "contract address must be an EVM 0x address or a base58 Solana address",
  })
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

export class CreateTokenDeploymentDto {
  /** chains.id — the dashboard picks from the chains table. */
  @IsUUID()
  chainId!: string;

  @IsString()
  @Matches(/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/, {
    message: "mint must be an EVM 0x address or a base58 Solana mint",
  })
  mint!: string;

  @IsInt()
  @Min(0)
  decimals!: number;

  @IsBoolean()
  @IsOptional()
  isVisible?: boolean;

  @IsBoolean()
  @IsOptional()
  isPinned?: boolean;

  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;
}

export class CreateTokenDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,24}$/, { message: "symbol must be 1-24 letters/digits/_/-" })
  symbol!: string;

  @IsString()
  @MaxLength(64)
  name!: string;

  @IsString()
  @Matches(/^https:\/\/coin-images\.coingecko\.com\//, {
    message: "logoSourceUrl must be a CoinGecko image URL from the preview step",
  })
  @MaxLength(512)
  @IsOptional()
  logoSourceUrl?: string;

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreateTokenDeploymentDto)
  @IsOptional()
  deployments?: CreateTokenDeploymentDto[];
}

export class UpdateTokenDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,24}$/, { message: "symbol must be 1-24 letters/digits/_/-" })
  @IsOptional()
  symbol?: string;

  @IsString()
  @MaxLength(64)
  @IsOptional()
  name?: string;
}

export class UpdateTokenDeploymentDto {
  @IsInt()
  @Min(0)
  @IsOptional()
  decimals?: number;

  @IsBoolean()
  @IsOptional()
  isVisible?: boolean;

  @IsBoolean()
  @IsOptional()
  isPinned?: boolean;

  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;
}

export class PreviewTokenDto {
  @IsIn(["solana", "eip155"])
  chainNamespace!: string;

  @IsString()
  @MaxLength(88)
  chainReference!: string;

  @IsString()
  @Matches(/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/, {
    message: "mint must be an EVM 0x address or a base58 Solana mint",
  })
  mint!: string;
}

export class PreviewChainDto {
  @IsIn(["solana", "eip155"])
  chainNamespace!: string;

  @IsString()
  @MaxLength(88)
  reference!: string;

  @IsString()
  @MaxLength(256)
  rpcUrl!: string;
}

/** F3: manual circuit-breaker resume. Evidence is required and recorded in the security log. */
export class CloseBreakerDto {
  @IsString()
  @MaxLength(88)
  chain!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(500)
  evidence!: string;
}

export class OpenRelayerBreakerDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class CloseRelayerBreakerDto {
  @IsString()
  @MaxLength(2000)
  evidence!: string;
}
