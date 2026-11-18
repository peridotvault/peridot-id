import { IsIn, IsOptional, IsString, IsUUID, Length } from "class-validator";
import type { WalletNamespace } from "../wallet-signature";

/**
 * Ask for a challenge to prove control of an external wallet address.
 * `action` defaults to `login`; `link` additionally requires a session.
 */
export class WalletChallengeDto {
  @IsIn(["solana", "evm"])
  namespace!: WalletNamespace;

  /** Chain reference the proof is bound to ("mainnet-beta", "1", …). */
  @IsString()
  @Length(1, 32)
  reference!: string;

  @IsString()
  @Length(20, 100)
  address!: string;

  @IsOptional()
  @IsIn(["login", "link"])
  action?: "login" | "link";
}

/**
 * Present the wallet's signature over the issued message. Encoding is per
 * chain: base64 (Solana) or hex (EVM).
 */
export class WalletVerifyDto {
  @IsUUID()
  challengeId!: string;

  @IsString()
  @Length(32, 200)
  signature!: string;
}
