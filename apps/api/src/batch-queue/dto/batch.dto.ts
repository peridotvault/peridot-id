import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEXDATA_RE = /^0x[0-9a-fA-F]*$/;
const UINT_RE = /^\d+$/;

/** One non-financial op (spec §3.1 FR-1, ERC-5792-adapted call object). */
export class BatchOpDto {
  /** Target contract (checksummed 0x address; EOAs and zero address rejected). */
  @Matches(EVM_ADDRESS_RE, { message: "Target is invalid" })
  to!: string;

  /** Wei as decimal string — MUST be "0" in phase-1a (non-financial only). */
  @Matches(UINT_RE, { message: "Value must be an integer" })
  value!: string;

  /** Calldata (non-empty, ≥ 4-byte selector). */
  @Matches(HEXDATA_RE, { message: "Data must be hex" })
  @MaxLength(131_072 + 2, { message: "Data exceeds per-op calldata cap" })
  data!: string;

  /** Optional per-op gas cap (decimal string); enforced if present. */
  @IsOptional()
  @Matches(UINT_RE, { message: "Gas limit must be an integer" })
  gasLimit?: string;

  /**
   * Opaque signed single-call authorization for this op (owner/session
   * signature over the EXISTING entrypoint — the queue never re-signs and
   * never changes auth; the flush path forwards each intent verbatim).
   */
  @IsObject()
  intent!: Record<string, unknown>;
}

export class BatchSessionKeyDto {
  @Matches(EVM_ADDRESS_RE, { message: "Session key address is invalid" })
  keyAddress!: string;

  @IsInt()
  @Min(0)
  sequence!: number;

  /** Session expiry (unix seconds) — settlement requires validUntil <= this. */
  @IsInt()
  @Min(0)
  expiresAt!: number;
}

export class EstimateBatchDto {
  @Matches(EVM_ADDRESS_RE, { message: "From address is invalid" })
  from!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => BatchOpDto)
  ops!: BatchOpDto[];

  @IsOptional()
  @IsBoolean()
  atomic?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => BatchSessionKeyDto)
  sessionKey?: BatchSessionKeyDto;
}

export class SubmitBatchDto extends EstimateBatchDto {
  /** Locked fee quote the ops were estimated against (must match ops hash). */
  @IsString()
  @MaxLength(128)
  quoteId!: string;

  /** Dedupe + replay guard (duplicate key returns the original batch). */
  @IsString()
  @MaxLength(128)
  idempotencyKey!: string;

  /** Urgent flows skip the timed flush and settle immediately (still sequential). */
  @IsOptional()
  @IsBoolean()
  bypassQueue?: boolean;
}
