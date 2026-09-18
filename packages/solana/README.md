# `@peridotvault/pid-solana`

PeridotID Solana adapter — passkey-based smart-account authority, built on
`@peridotvault/pid-core` primitives. Only `pid-core` and `pid-solana` may import
`@solana/web3.js` (web3.js layering rule). Pure functions and adapters for
building, signing, and submitting smart-account transactions without a wallet.

## Install

```sh
npm install @peridotvault/pid-solana
```

## Why

PeridotID smart accounts are controlled by a **secp256r1 passkey** (WebAuthn), not an
ED25519 keypair. This adapter wires browser WebAuthn assertions to Solana `secp256r1`
precompile instructions so a passkey can authorize SOL/token transfers and authority
changes — fully non-custodial.

## Sessions (ADR-010)

Gameplay sessions use Ed25519 session keys in isolated PDAs — one owner P-256
ceremony at registration, then envelope signatures + on-chain record checks.
Builders: `deriveSessionAddress`, `deriveProgramDataAddress`,
`buildRegisterSessionPayload`, `buildRevokeSessionPayload`,
`buildCloseSessionPayload`, `serializeSessionMetas`,
`buildRegisterSessionInstruction`, `buildSessionExecuteInstruction`,
`buildRevokeSessionInstruction`, `buildCloseSessionInstruction`
(`src/instructions.ts`, layouts match the program exactly).

Scope note: this adapter is Solana-only. The EVM V4 permission layer (scoped
session keys, ERC-7579, ERC-1271 — ADR 009) lives in `@peridotvault/pid-evm`
and `contracts/evm`; nothing in it ports to Solana (structurally different
boundary).

## Usage

```ts
import { deriveSmartAccountAddress, buildDepositSolInstruction, SolanaAdapter } from '@peridotvault/pid-solana';

// Derive the smart-account PDA for a PID
const smartAccount = deriveSmartAccountAddress(pid);
```

### Browser passkey signing

```ts
import { SolanaAdapter, type PasskeySigner } from '@peridotvault/pid-solana';

const signer: PasskeySigner = {
  getAssertion: async (challenge, allowCredentials) => {
    // drive WebAuthn navigator.credentials.get here
  },
};

const adapter = new SolanaAdapter({ rpcUrl, programId });
```

## API surface

Primitives (`bytes`, payload hashes, WebAuthn ceremonies, key custody) live in
`@peridotvault/pid-core` and are re-exported here, so existing imports keep working:

- **Core** — `deriveSmartAccountAddress`, `pidToSeed32`, `buildAuthorizationPayload`,
  `buildWebAuthnMessage`, `buildWithdrawPayload`, `DOMAIN`, `PID_PROGRAM_ID`,
  `INSTRUCTIONS_SYSVAR`, `SECP256R1_PRECOMPILE`, `sha256`
- **Bytes** — `b64url`, `b64urlToBytes`, `concat`, `derToRawEcdsa`, `fromAscii`,
  `fromHex`, `toHex`, `i64le`, `u64le`, `u16le`, `normalizeLowS`, `SECP256R1_ORDER`
- **Instructions** — `buildInitializeInstruction`, `buildDepositSolInstruction`,
  `buildDepositTokenInstruction`, `buildWithdrawSolInstruction`,
  `buildWithdrawTokenInstruction`, `buildUpdateAuthorityInstruction`,
  `buildSecp256r1Instruction`, `smartAccountAta`
- **RPC/adapter** — `SolanaRpc`, `ChainRpc`, `SolanaAdapter`, `PasskeyAssertion`,
  `PasskeySigner`, `TransactionStatus`

> Note: the `secp256r1` precompile enforces low-S and does not simulate correctly —
> send with `skipPreflight`. This package ships its own pure-Rust-free SHA-256
> (`src/sha256.ts`) since the `sol_sha256` syscall is unsupported on some SBF toolchains.

## Publish

```sh
pnpm --filter @peridotvault/pid-solana publish --access public --no-git-checks
```

Publish after `pid-types`, before `pid-sdk-js`.