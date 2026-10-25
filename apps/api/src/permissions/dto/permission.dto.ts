import { IsInt, IsString, Matches, Max, Min } from "class-validator";

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HEX4 = /^0x[0-9a-fA-F]{8}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^\d+$/;

/** Owner-signed permission grant (mirrors `PeridotAccount.GrantArgs`; see WHITEPAPER.md §10).
 * ANT-556 Option A: sessions are NONFINANCIAL-only (kind 1). Kinds 2-5 were
 * removed on-chain and are rejected here (defense in depth). */
export class GrantPermissionDto {
  /** 1 = nonfinancial (only). Kinds 2-5 (ETH/ERC-20/721/1155) were removed (ANT-556 Option A). */
  @IsInt()
  @Min(1)
  @Max(1)
  kind!: number;

  /** Nonfinancial: exact allowed target. Must be nonzero (and never the account/factory — checked in service). */
  @Matches(ADDR, { message: "target must be a 0x address" })
  target!: string;

  /** Nonfinancial: exact allowed selector (4 bytes). */
  @Matches(HEX4, { message: "selector must be 0x + 8 hex chars" })
  selector!: string;

  /** Financial: token contract (zero address = native ETH). */
  @Matches(ADDR, { message: "token must be a 0x address" })
  token!: string;

  /** Financial: recipient (zero address = unset). */
  @Matches(ADDR, { message: "to must be a 0x address" })
  to!: string;

  /** Financial: max per execution, raw units (wei / token base units / NFT amount). */
  @Matches(UINT, { message: "perTxCap must be a uint string" })
  perTxCap!: string;

  /** Financial: lifetime cap in the same units. */
  @Matches(UINT, { message: "totalLimit must be a uint string" })
  totalLimit!: string;

  /** Owner-approved lifetime session-fee cap (raw wei; ANT-556 Security condition).
   * REQUIRED: 0n means only zero-fee executions pass on-chain. Must be explicit. */
  @Matches(UINT, { message: "feeLimit must be a uint string" })
  feeLimit!: string;

  /** ERC-721/1155: token id. */
  @Matches(UINT, { message: "nftId must be a uint string" })
  nftId!: string;

  /** Session P-256 key, x coordinate. */
  @Matches(HEX32, { message: "sessionX must be 0x + 64 hex chars" })
  sessionX!: string;

  /** Session P-256 key, y coordinate. */
  @Matches(HEX32, { message: "sessionY must be 0x + 64 hex chars" })
  sessionY!: string;

  @IsInt()
  @Min(0)
  validAfter!: number;

  @IsInt()
  @Min(0)
  validUntil!: number;

  /** Owner-chosen uniqueness salt. */
  @Matches(HEX32, { message: "salt must be 0x + 64 hex chars" })
  salt!: string;

  /** Owner-authorization deadline (unix seconds, TTL ≤ 600s enforced). */
  @IsInt()
  @Min(0)
  deadline!: number;

  /** Grant context (binds chain + account; part of the signed payload). */
  @IsInt()
  @Min(1)
  chainId!: number;

  @Matches(ADDR, { message: "account must be a 0x address" })
  account!: string;

  /** Owner nonce the grant will consume. */
  @IsString()
  @Matches(UINT, { message: "nonce must be a uint string" })
  nonce!: string;

  /** Deploying factory (blocked as a permission target). */
  @Matches(ADDR, { message: "factory must be a 0x address" })
  factory!: string;
}
