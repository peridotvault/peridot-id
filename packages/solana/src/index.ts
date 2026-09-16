// Peridot Solana adapter — chain adapter and instruction builders on top of
// @peridotvault/pid-core primitives (ADR 007 §8).

export {
  buildActivatePayload,
  buildActivatePayloadV2,
  buildActivatePayloadV3,
  pidToSeed32,
  buildAuthorizationPayload,
  buildAuthorizationPayloadV2,
  buildAuthorizationPayloadV3,
  buildClosePayloadV2,
  buildClosePayloadV3,
  buildExecutePayloadV3,
  buildInitializePayload,
  buildInitializePayloadV2,
  buildInitializePayloadV3,
  buildUpdateAuthorityPayloadV2,
  buildUpdateAuthorityPayloadV3,
  buildWebAuthnMessage,
  buildWithdrawPayload,
  buildWithdrawPayloadV2,
  buildWithdrawPayloadV3,
  buildWithdrawTokenPayload,
  buildWithdrawTokenPayloadV2,
  buildWithdrawTokenPayloadV3,
  deriveSmartAccountAddress,
  DOMAIN,
  DOMAIN_V2,
  DOMAIN_V3,
  executeCallHash,
  EXECUTE_FLAG,
  INSTRUCTIONS_SYSVAR,
  IX,
  MAX_EXECUTE_DATA,
  MAX_EXECUTE_METAS,
  OP,
  PID_PROGRAM_ID,
  SECP256R1_PRECOMPILE,
  serializeExecuteCall,
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
export type { ExecuteMeta } from "@peridotvault/pid-core";
export {
  buildActivateInstruction,
  buildActivateInstructionV2,
  buildActivateInstructionV3,
  buildCloseInstruction,
  buildDepositSolInstruction,
  buildDepositTokenInstruction,
  buildExecuteInstructionV3,
  buildInitializeInstruction,
  buildInitializeInstructionV2,
  buildSecp256r1Instruction,
  buildUpdateAuthorityInstruction,
  buildWithdrawSolInstruction,
  buildWithdrawSolInstructionV2,
  buildWithdrawSolInstructionV3,
  buildWithdrawTokenInstruction,
  buildWithdrawTokenInstructionV2,
  buildWithdrawTokenInstructionV3,
  smartAccountAta,
} from "./instructions";
export { SolanaRpc } from "./rpc";
export type { ChainRpc, ParsedTx, TokenBalance } from "./rpc";
export { SolanaAdapter } from "./adapter";
export type { TransactionStatus } from "./adapter";
export type { PasskeyAssertion, PasskeySigner } from "@peridotvault/pid-core";
export { Keypair, PublicKey } from "@solana/web3.js";
export type { Keypair as SolanaKeypair } from "@solana/web3.js";