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
