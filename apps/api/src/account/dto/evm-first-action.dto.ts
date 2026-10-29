import { Type } from "class-transformer";
import { IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from "class-validator";
import { EvmActivateAssertionDto } from "./evm-activate.dto";

/**
 * WS1 §3.1 lazy first-action (EVM): one user intent carrying BOTH the
 * passkey-bound activation authorization AND the first `execute`
 * authorization. The relayer runs `deployAndInitV4` → `executeV4` back-to-back
 * (two txs, one approval, no separate activate step).
 */
class EvmFirstActionActivationDto {
  /** The quoted deploy-leg network fee the activation assertion was signed against. */
  @Matches(/^\d+$/, { message: "Quoted network fee must be wei (positive integer)" })
  quotedNetworkFeeWei!: string;

  /** Signed fee-policy version (2 = V4 only; policy 1 sunset is rejected). */
  @IsInt()
  @Min(2)
  @Max(2)
  feePolicyVersion!: number;

  /** User-approved bound on the deploy-leg total (REQUIRED). */
  @IsOptional()
  @Matches(/^\d+$/, { message: "maxTotalFee must be wei (positive integer)" })
  maxTotalFeeWei?: string;

  /** Activation authorization deadline (unix seconds, TTL ≤ 600s). */
  @IsInt()
  @Min(0)
  deadline!: number;

  @IsObject()
  @ValidateNested()
  @Type(() => EvmActivateAssertionDto)
  assertion!: EvmActivateAssertionDto;
}

class EvmFirstActionExecuteDto {
  /** Execute target (never the account itself — enforced on-chain). */
  @Matches(/^0x[0-9a-fA-F]{40}$/, { message: "to must be a 0x EVM address" })
  to!: string;

  /** Native value in wei (decimal string). */
  @Matches(/^\d+$/, { message: "value must be wei (positive integer)" })
  value!: string;

  /** Calldata (0x hex, ≤ 10_240 bytes — mirrors the on-chain permission cap). */
  @Matches(/^0x[0-9a-fA-F]*$/, { message: "data must be 0x hex" })
  data!: string;

  /** Execute authorization deadline (unix seconds, TTL ≤ 600s). */
  @IsInt()
  @Min(0)
  deadline!: number;

  /** Signed fee-policy version for the execute leg (2 = V4 only). */
  @IsInt()
  @Min(2)
  @Max(2)
  feePolicyVersion!: number;

  /** User-approved bound on the execute-leg total (REQUIRED). */
  @IsOptional()
  @Matches(/^\d+$/, { message: "maxTotalFee must be wei (positive integer)" })
  maxTotalFeeWei?: string;

  /** The quoted execute-leg network fee the assertion was signed against. */
  @Matches(/^\d+$/, { message: "Quoted network fee must be wei (positive integer)" })
  quotedNetworkFeeWei!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => EvmActivateAssertionDto)
  assertion!: EvmActivateAssertionDto;
}

export class EvmFirstActionDto {
  /**
   * Idempotency key for the whole first-action (client uuid; server generates
   * one when absent). Correlates deploy + execute across logs, records, and
   * retries — a resubmit with the same id never deploys nor executes twice.
   */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  firstActionId?: string;

  @IsObject()
  @ValidateNested()
  @Type(() => EvmFirstActionActivationDto)
  activation!: EvmFirstActionActivationDto;

  @IsObject()
  @ValidateNested()
  @Type(() => EvmFirstActionExecuteDto)
  execute!: EvmFirstActionExecuteDto;
}
