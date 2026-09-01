# `@peridotvault/pid-solana`

PeridotID Solana adapter — passkey-based smart-account authority. The **only** package
allowed to import `@solana/web3.js` (ADR 007 §8). Pure functions and adapters for
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

## Usage

```ts
import { deriveSmartAccountAddress, buildDepositSolInstruction, SolanaAdapter } from '@peridotvault/pid-solana';

// Derive the smart-account PDA for an account id
const smartAccount = deriveSmartAccountAddress(accountId);
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

- **Core** — `deriveSmartAccountAddress`, `accountIdToSeed32`, `buildAuthorizationPayload`,
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