import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";
import { PID_REGEX } from "../../common/pid";

export class LedgerTransferInquiryDto {
  @Matches(/^\d+$/, { message: "Amount must be whole IDR (positive integer)" })
  amountIdr!: string;

  /** Recipient identity (e.g. `rani@pid`) — resolved server-side. */
  @Matches(PID_REGEX, { message: "beneficiaryPid must be a PID like name@pid" })
  beneficiaryPid!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  remark?: string;

  /** Optional app context (model A): when set, this app's transaction fee applies. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  clientId?: string;

  /**
   * Fee operation for the app context. Defaults to `transaction`. `escrow`
   * carries no app fee (used for campaign funding/refund legs) and, for a
   * verified app, also skips the global fee — giving an exact full refund.
   */
  @IsOptional()
  @IsIn(["transaction", "escrow"])
  operation?: "transaction" | "escrow";
}

export class LedgerFreezeDto {
  @IsBoolean()
  frozen!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  reason?: string;
}

export class DispatchEventsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;
}

export class LedgerAdjustDto {
  /** Debited identity (must exist; balance rechecked inside the txn). */
  @Matches(PID_REGEX, { message: "fromPid must be a PID like name@pid" })
  fromPid!: string;

  /** Credited identity (must exist; distinct from fromPid). */
  @Matches(PID_REGEX, { message: "toPid must be a PID like name@pid" })
  toPid!: string;

  @Matches(/^\d+$/, { message: "Amount must be whole IDR (positive integer)" })
  amountIdr!: string;

  /** Audited reason (min 8 chars) — adjustments are immutable once posted. */
  @IsString()
  @MaxLength(512)
  reason!: string;

  /**
   * Client-supplied idempotency key (ANT-264: Tobias Finding 2). When set,
   * a retried POST with the same key returns the original entryGroup instead
   * of minting a second correction pair. Same key + different
   * fromPid/toPid/amount → 409. The `Idempotency-Key` header carries the
   * same value and wins over this field when both are present.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, { message: "requestId must be 1-64 chars of [A-Za-z0-9_-]" })
  requestId?: string;
}
