// Peridot Solana adapter — chain adapter and instruction builders on top of
// @peridotvault/pid-core primitives (ADR 007 §8).

export {
  accountIdToSeed32,
  buildAuthorizationPayload,
  buildWebAuthnMessage,
  buildWithdrawPayload,
  deriveSmartAccountAddress,
  DOMAIN,
  INSTRUCTIONS_SYSVAR,
  IX,
  PID_PROGRAM_ID,
  SECP256R1_PRECOMPILE,
  sha256,
} from "@peridotvault/pid-core";
export {
  b64url,
  b64urlToBytes,
  concat,
  derToRawEcdsa,
  fromAscii,
  fromHex,
  i64le,
  normalizeLowS,
  SECP256R1_ORDER,
  toHex,
  u16le,
  u64le,
} from "@peridotvault/pid-core";
export type { Bytes } from "@peridotvault/pid-core";
export {
  buildActivateInstruction,
  buildDepositSolInstruction,
  buildDepositTokenInstruction,
  buildInitializeInstruction,
  buildSecp256r1Instruction,
  buildUpdateAuthorityInstruction,
  buildWithdrawSolInstruction,
  buildWithdrawTokenInstruction,
  smartAccountAta,
} from "./instructions";
export { SolanaRpc } from "./rpc";
export type { ChainRpc, ParsedTx, TokenBalance } from "./rpc";
export { SolanaAdapter } from "./adapter";
export type { TransactionStatus } from "./adapter";
export type { PasskeyAssertion, PasskeySigner } from "@peridotvault/pid-core";
export { Keypair, PublicKey } from "@solana/web3.js";
export type { Keypair as SolanaKeypair } from "@solana/web3.js";