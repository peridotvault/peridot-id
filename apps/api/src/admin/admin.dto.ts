// Admin chain-registry DTOs. Secrets never appear in RESPONSES — the EVM
// relayer key (EvmRelayerKey, dashboard-managed since ANT-193) is write-only
// via the admin API and read server-side only. Other relayer keys and RPC API
// keys stay in env by design.
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { MAX_PROTOCOL_FEE_BPS } from "../common/solana-relay";

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

/** One per-chain MIN_FEE leg of a new fee-policy version (base units, decimal string). */
export class FeePolicyMinDto {
  @IsIn(["solana", "eip155", "stellar"])
  namespace!: string;

  @IsString()
  @MaxLength(128)
  reference!: string;

  @Matches(/^\d+$/, { message: "minFee must be a non-negative integer (base units)" })
  minFee!: string;
}

/**
 * Publish a new chain fee-policy version (ANT-730, spec §4.3). New versions
 * only — published rows are never mutated. Every minimum must sit at or
 * above the chain's on-chain settlement floor (`ChainMinBelowFloor`
 * otherwise, AC-10). The row starts inactive; activate it via
 * `POST /v1/admin/fee-policies/:version/activate`.
 */
export class CreateFeePolicyDto {
  // ANT-732 LOW: bps=0 + empty minima would quote zero fees (revenue kill),
  // and no spec calls for a fee holiday — floor at 1 (explicit accept: a
  // deliberate 0-bps policy needs a contract-review exception, not a form).
  @IsInt()
  @Min(1)
  @Max(MAX_PROTOCOL_FEE_BPS)
  bps!: number;

  // ANT-732 LOW: bound the batch (each entry becomes a row; unbounded arrays
  // are a cheap write-amplification vector). 64 chains is far above the
  // registry size; dup legs are rejected 400 in the service (no P2002 500).
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => FeePolicyMinDto)
  minima!: FeePolicyMinDto[];

  @IsString()
  @MaxLength(64)
  @IsOptional()
  fxSource?: string;

  @IsString()
  @MaxLength(32)
  @IsOptional()
  fxAsOf?: string;
}
