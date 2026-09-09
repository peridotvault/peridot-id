// PeridotID core primitives — reusable identity/crypto/hash building blocks.
//
// Layering (ADR 007 §8): pid-core owns dependency-free primitives plus the key
// types both layers share. pid-solana (chain adapter/instructions) and pid-sdk-js
// (direct API client) build on top. The public login UX (redirects, hosted login,
// prod defaults) lives in pid-react and must never leak down here: no navigation,
// no hosts, no app flow.

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
} from "./hash";
export {
  asciiOf,
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
  assertCeremonyOrigin,
  authenticatePasskey,
  BrowserPasskeySigner,
  PasskeyHostedRequiredError,
  registerPasskey,
} from "./webauthn";
export type { PasskeyAssertion, PasskeySigner } from "./webauthn";
export {
  FeePayerManager,
  InMemorySecretStore,
  LocalStorageSecretStore,
  type SecretStore,
} from "./custody";
export { LocalHistoryStore, type HistoryStore } from "./cache";
export { Keypair, PublicKey } from "@solana/web3.js";
export type { Keypair as SolanaKeypair } from "@solana/web3.js";
