import { IsEnum, IsNotEmpty, IsObject, IsOptional, IsString, Matches } from "class-validator";

const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

class IntentPayloadDto {
  @Matches(/^\d+$/, { message: "Jumlah harus lebih dari 0" })
  amount!: string;

  @IsOptional()
  @Matches(SOLANA_PUBKEY_RE, { message: "Tujuan tidak valid" })
  destination?: string;

  @IsOptional()
  @Matches(SOLANA_PUBKEY_RE, { message: "Mint tidak valid" })
  mint?: string;

  @IsOptional()
  @Matches(SOLANA_PUBKEY_RE, { message: "Tujuan tidak valid" })
  destinationAta?: string;
}

export class CreateIntentDto {
  @IsEnum(["WITHDRAW_SOL", "WITHDRAW_TOKEN"])
  type!: "WITHDRAW_SOL" | "WITHDRAW_TOKEN";

  @IsObject()
  payload!: IntentPayloadDto;
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
}