import { IsIn, IsISO8601, IsObject, IsOptional, IsString, Length, Matches, MaxLength } from "class-validator";
import { PID_REGEX } from "../../common/pid";
export class PaymentQuoteDto {
  @Matches(/^[1-9][0-9]{0,11}$/) amountIdr!: string;
  @IsOptional() @IsString() @Length(1, 100) clientId?: string;
  @IsOptional() @IsString() @MaxLength(60) paymentMethod?: string;
}
export class CreatePaymentDto extends PaymentQuoteDto {
  @IsString() @Length(1, 128) externalId!: string;
  @IsOptional() @Matches(PID_REGEX) beneficiaryPid?: string;
  // Machine callers may omit payer. A machine identity never becomes the payer.
  @IsOptional() @Matches(PID_REGEX) payerPid?: string;
  @IsOptional() @IsString() @MaxLength(256) description?: string;
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}
export class ListPaymentsDto {
  @IsOptional() @IsString() @MaxLength(128) externalId?: string;
  @IsOptional() @IsIn(["created", "pending", "paid", "expired", "failed", "cancelled"]) status?: string;
  @IsOptional() @IsISO8601() createdAfter?: string;
  @IsOptional() @IsString() @MaxLength(100) clientId?: string;
}
export class RefundPaymentDto {
  @IsString() @Length(1, 64) requestId!: string;
  @IsOptional() @Matches(/^[1-9][0-9]{0,11}$/) amountIdr?: string;
}
