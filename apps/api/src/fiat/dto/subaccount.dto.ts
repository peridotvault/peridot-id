import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";
import { PID_REGEX } from "../../common/pid";

export class CreateSubAccountDto {
  @IsString()
  @MaxLength(128)
  name!: string;

  @IsString()
  @MaxLength(25)
  email!: string;
}

export class SubHistoryQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(22)
  accountNo?: string;

  @IsString()
  fromDateTime!: string;

  @IsString()
  toDateTime!: string;

  @IsOptional()
  @Matches(/^\d+$/, { message: "pageSize must be numeric" })
  pageSize?: string;

  @IsOptional()
  @Matches(/^\d+$/, { message: "pageNumber must be numeric" })
  pageNumber?: string;
}

/** Bank/e-wallet payouts are deferred — internal transfers only for now. */
export const SAC_TRANSFER_TYPES = ["DOKU_SUB_ACCOUNT"] as const;

export class TransferInquiryDto {
  @IsIn([...SAC_TRANSFER_TYPES])
  type!: (typeof SAC_TRANSFER_TYPES)[number];

  @Matches(/^\d+$/, { message: "Amount must be whole IDR (positive integer)" })
  amountIdr!: string;

  /** Recipient identity (e.g. `rani@pid`) — resolved server-side to their
   *  POINT account. Senders never handle account numbers. */
  @Matches(PID_REGEX, { message: "beneficiaryPid must be a PID like name@pid" })
  beneficiaryPid!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  remark?: string;
}

export class TransferConfirmDto {
  /** Beneficiary name from the inquiry step — shown, never trusted blindly. */
  @IsString()
  @MaxLength(256)
  beneficiaryAccountName!: string;

  /** Re-verify the holder name matches the inquiry before executing. */
  @IsOptional()
  @IsString()
  expectedName?: string;
}

export class DebitDto {
  @Matches(/^\d+$/, { message: "Amount must be whole IDR (positive integer)" })
  amountIdr!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  description?: string;
}

export class DebitCancelDto {
  @Matches(/^\d+$/, { message: "Amount must be whole IDR (positive integer)" })
  refundAmountIdr!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  reason?: string;
}

export class SplitRuleItemDto {
  @IsIn(["PERCENTAGE", "FLAT"])
  type!: "PERCENTAGE" | "FLAT";

  @IsNumber()
  @Min(0)
  value!: number;

  @IsOptional()
  @IsString()
  @MaxLength(6)
  currency?: string;

  @IsInt()
  @Min(0)
  @Max(9999999999)
  accountNumber!: number;
}

export class CreateSplitRuleDto {
  @IsString()
  @MaxLength(64)
  transactionType!: string;

  rules!: SplitRuleItemDto[];
}

export class CreateFeePolicyDto {
  @IsInt()
  @Min(1)
  @Max(10000)
  percentBps!: number;

  @Matches(/^\d+$/, { message: "minIdr must be whole IDR" })
  minIdr!: string;

  @Matches(/^\d+$/, { message: "maxIdr must be whole IDR" })
  maxIdr!: string;
}

export class CheckoutDepositDto {
  /** Net deposit, whole IDR (credited to the user; fee is quoted on top). */
  @Matches(/^\d+$/, { message: "Amount must be whole IDR (positive integer)" })
  netAmountIdr!: string;

  /** Optional app context (model A): when set, this app's topup fee applies. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  clientId?: string;
}

export class ReconcileDto {
  @IsString()
  fromDateTime!: string;

  @IsString()
  toDateTime!: string;
}

export class AdminSweepDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  skip?: number;
}

export class AdminBackfillDto {
  @IsOptional()
  @Matches(PID_REGEX, { message: "pid must be a PID like name@pid" })
  pid?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  take?: number;
}

export class AdminClawbackDto {
  @IsString()
  @MaxLength(64)
  transactionId!: string;

  @Matches(/^\d+$/, { message: "Amount must be whole IDR (positive integer)" })
  amountIdr!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  reason?: string;
}

export class AdminHaltDto {
  @IsBoolean()
  halt!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  reason?: string;
}

export class RedemptionRequestDto {
  @Matches(/^\d+$/, { message: "Amount must be whole IDR (positive integer)" })
  amountIdr!: string;

  /** Destination bank code (DOKU-validated; unknown codes fail as failed payout). */
  @IsString()
  @MaxLength(16)
  bankCode!: string;

  @IsString()
  @MaxLength(32)
  bankAccountNumber!: string;

  @IsString()
  @MaxLength(256)
  bankAccountName!: string;

  @IsOptional()
  @IsIn(["BI_FAST", "ONLINE"])
  channel?: "BI_FAST" | "ONLINE";

  /** Optional app context: when set, this app's withdraw fee applies. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  clientId?: string;
}
