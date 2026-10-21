import { Type } from "class-transformer";
import { IsEnum, IsNotEmpty, IsObject, IsOptional, IsString, Matches, ValidateNested } from "class-validator";

const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

class IntentPayloadDto {
  @Matches(/^\d+$/, { message: "Jumlah harus lebih dari 0" })
  amount!: string;

  @IsOptional()
  @Matches(SOLANA_PUBKEY_RE, { message: "Destination is invalid" })
  destination?: string;

  @IsOptional()
  @Matches(SOLANA_PUBKEY_RE, { message: "Mint is invalid" })
  mint?: string;

  @IsOptional()
  @Matches(SOLANA_PUBKEY_RE, { message: "Destination is invalid" })
  destinationAta?: string;
}

export class CreateIntentDto {
  @IsEnum(["WITHDRAW_SOL", "WITHDRAW_TOKEN"])
  type!: "WITHDRAW_SOL" | "WITHDRAW_TOKEN";

  // ANT-344 L4: without @ValidateNested + @Type the IntentPayloadDto rules
  // (amount digits, base58 destination/mint) never ran — any object passed.
  @IsObject()
  @ValidateNested()
  @Type(() => IntentPayloadDto)
  payload!: IntentPayloadDto;
}

export class ChainEchoDto {
  @IsString()
  @IsNotEmpty()
  namespace!: string;

  @IsString()
  @IsNotEmpty()
  reference!: string;
}

export class RecordTransactionDto {
  @IsString()
  @IsNotEmpty()
  intentId!: string;

  @IsString()
  @IsNotEmpty()
  txHash!: string;

  @IsOptional()
  @IsString()
  network?: string;

  /** Optional CAIP-2 chain: when present the server derives `network` from the registry and ignores `network`. */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ChainEchoDto)
  chain?: ChainEchoDto;
}

export class RecordActivityDto {
  @IsEnum(["DEPOSIT", "WITHDRAW", "ACTIVATION"])
  type!: "DEPOSIT" | "WITHDRAW" | "ACTIVATION";

  @Matches(/^\d+$/, { message: "Jumlah harus lebih dari 0" })
  amount!: string;

  @IsString()
  @IsNotEmpty()
  asset!: string;

  @IsEnum(["in", "out"])
  direction!: "in" | "out";

  @IsOptional()
  @IsString()
  counterparty?: string;

  @IsOptional()
  @IsString()
  txHash?: string;
}