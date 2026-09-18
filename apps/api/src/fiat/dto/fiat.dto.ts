import { IsIn, IsOptional, IsString, Matches } from "class-validator";

export class CreateTopupDto {
  /** Whole IDR, e.g. "10000". Min Rp10.000 enforced in the service. */
  @Matches(/^\d+$/, { message: "Amount must be whole IDR (positive integer)" })
  amountIdr!: string;
}

export class RequestWithdrawDto {
  @Matches(/^\d+$/, { message: "Amount must be whole IDR (positive integer)" })
  amountIdr!: string;

  @IsOptional()
  @IsString()
  bankCode?: string;

  @IsOptional()
  @IsString()
  accountNumber?: string;

  @IsOptional()
  @IsString()
  accountName?: string;
}

export class SettleWithdrawDto {
  @IsIn(["settled", "rejected"], { message: "Decision must be settled or rejected" })
  decision!: "settled" | "rejected";
}
