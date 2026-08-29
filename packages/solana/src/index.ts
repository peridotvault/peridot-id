// Peridot Solana adapter — the only package allowed to depend on @solana/web3.js (ADR 007 §8).

export {
  accountIdToSeed32,
  buildAuthorizationPayload,
  buildWebAuthnMessage,
  buildWithdrawPayload,
  deriveSmartAccountAddress,
  DOMAIN,
  INSTRUCTIONS_SYSVAR,
  IX,
  PERIDOT_PROGRAM_ID,
  SECP256R1_PRECOMPILE,
  sha256,
} from "./core";
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
} from "./bytes";
export type { Bytes } from "./bytes";
export {
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
export type { ChainRpc } from "./rpc";
export { SolanaAdapter } from "./adapter";
export type { PasskeyAssertion, PasskeySigner, TransactionStatus } from "./adapter";