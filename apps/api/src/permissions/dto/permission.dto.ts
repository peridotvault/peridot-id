import { IsInt, IsString, Matches, Max, Min } from "class-validator";

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HEX4 = /^0x[0-9a-fA-F]{8}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^\d+$/;

/** Owner-signed permission grant (mirrors `PeridotAccount.GrantArgs`; see WHITEPAPER.md §10). */
export class GrantPermissionDto {
  /** 1 = nonfinancial, 2 = ETH, 3 = ERC-20, 4 = ERC-721, 5 = ERC-1155. */
  @IsInt()
  @Min(1)
  @Max(5)
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
