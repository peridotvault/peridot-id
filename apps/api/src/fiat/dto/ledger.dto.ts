import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";
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
