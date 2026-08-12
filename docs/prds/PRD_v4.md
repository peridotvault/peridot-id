# PRD_v4.md — Peridot ID Non-Custodial Smart Wallet & Multi-Chain Account Platform

**Version:** 4.0  
**Status:** Implementation PRD  
**Primary implementation agent:** OpenCode  
**Primary chain for V1:** Solana  
**Future chains:** EVM and other chains through adapters  
**Gas sponsorship:** Explicitly OUT OF SCOPE for V1

---

# 0. Executive Summary

Peridot ID is the identity, authentication, wallet, and account-abstraction layer for the Peridot ecosystem.

The target UX is:

```text
Google / Discord / OAuth Login
        ↓
Peridot ID
        ↓
Peridot Wallet
        ↓
Solana Smart Account
        ↓
Sign / Execute Transaction
        ↓
Solana
```

The user must NOT need:

- Phantom
- MetaMask
- a seed phrase
- knowledge of a private key
- a separate native wallet UI

The user should experience one logical **Peridot Wallet**, while technically owning separate accounts on each supported blockchain:

```text
Peridot ID
   │
   └── Peridot Wallet
         ├── Solana Smart Account
         ├── Ethereum Smart Account (future)
         ├── Base Smart Account (future)
         └── other chains (future)
```

## Critical security requirement

Peridot must not store a user's plaintext blockchain private key or seed phrase.

However, V1 must acknowledge an important Solana constraint:

**A Solana transaction still needs a fee payer that is a valid signer (a keypair-controlled account) holding sufficient SOL. A PDA smart account does not itself possess a private key and cannot directly be the transaction fee payer.**

Therefore, because gas sponsorship is explicitly excluded from V1, the Peridot Wallet must include a **user-controlled fee-payer signing authority** for Solana transactions. The fee payer is part of the wallet implementation, not an external wallet provider.

The V1 design must therefore distinguish:

1. **Smart Account** — the user's programmable on-chain account.
2. **Signing Authority** — the cryptographic authority authorized to operate the Smart Account.
3. **Fee Payer Account** — a user-controlled Solana signer holding SOL for transaction fees.

The UX must hide these distinctions from the user.

---

# 1. Goals

## 1.1 Primary Goals

Build a production-oriented foundation for Peridot ID that provides:

- OAuth/OIDC authentication.
- Google login.
- Discord login.
- Extensible OAuth provider support.
- Peridot identity.
- Embedded Peridot Wallet UX.
- Solana Smart Account.
- Cryptographic transaction authorization.
- Transaction signing.
- Transaction submission.
- Transaction confirmation/status.
- User-controlled SOL fee payment.
- Multi-device account access architecture.
- Recovery architecture.
- SDK for Peridot applications.
- Chain abstraction.
- Solana adapter.
- Future EVM adapter interface.
- On-chain Solana program.
- Secure database model.
- Auditability and transaction history.
- Local, staging/devnet, and production environments.

## 1.2 Non-Goals for V1

DO NOT implement:

- Gas sponsorship.
- Paymaster.
- Kora.
- Server-paid transaction fees.
- Session keys.
- Social recovery execution.
- MPC.
- Multi-party signing.
- EVM smart account implementation.
- Cross-chain bridging.
- Cross-chain transactions.
- Hardware-wallet integration.
- Token swaps.
- DeFi integrations.
- NFT marketplace logic.
- Custodial server-side transaction signing.
- Server-side plaintext private-key storage.

These can be future phases.

---

# 2. Core Product Principles

## Principle 1 — Peridot ID is not merely OAuth

Peridot ID consists of:

```text
Identity
Authentication
Account
Wallet
Authorization
Chain adapters
```

## Principle 2 — OAuth is identity, not blockchain signing

Google/Discord/etc. establish:

```text
"This is user X."
```

They do NOT directly sign Solana transactions.

## Principle 3 — Smart Account is the on-chain programmable account

The Smart Account is controlled by an authorization mechanism rather than requiring the user to interact with a traditional wallet extension.

## Principle 4 — Peridot must not possess unilateral control over user assets

The Peridot backend must never be able to sign arbitrary user transactions merely because the backend knows the user's OAuth identity.

## Principle 5 — One UX, multiple chain accounts

The user sees:

```text
Peridot Wallet
```

Internally:

```text
Solana account
EVM account
...
```

## Principle 6 — Chain-specific code belongs behind adapters

The core account model must not contain Solana-specific assumptions.

---

# 3. Target User Experience

## 3.1 Registration

```text
User
 ↓
Create Peridot Account
 ↓
Continue with Google
 ↓
OAuth consent
 ↓
Peridot ID created
 ↓
Peridot Wallet created
 ↓
Solana Smart Account created/initialized
 ↓
Wallet ready
```

The user must never be asked to:

- write down a seed phrase;
- copy a private key;
- install Phantom;
- install MetaMask.

## 3.2 Login

```text
Peridot application
 ↓
Login with Peridot
 ↓
Google / Discord / OAuth
 ↓
Peridot session
 ↓
Peridot Wallet available
```

## 3.3 Transaction

```text
User clicks "Buy"
 ↓
Application creates Intent
 ↓
Peridot SDK
 ↓
Peridot Account Service
 ↓
Policy validation
 ↓
Wallet signing flow
 ↓
Solana transaction
 ↓
User's fee payer pays SOL fee
 ↓
Solana Smart Account executes
 ↓
Confirmation
 ↓
Application receives result
```

---

# 4. Architecture

```text
                         PERIDOT ID
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
   Identity/Auth        Account Service      Wallet Service
        │                    │                    │
        │                    │                    │
        └────────────────────┼────────────────────┘
                             ▼
                       Intent / Policy
                             │
                             ▼
                       Chain Router
                             │
                 ┌───────────┴───────────┐
                 ▼                       ▼
          Solana Adapter             EVM Adapter
                 │                    (future)
                 ▼
         Solana Smart Account
                 │
                 ▼
            Solana Network
```

---

# 5. Service Responsibilities

## 5.1 Identity/Auth Service

Responsibilities:

- OAuth/OIDC login.
- Google.
- Discord.
- Provider linking.
- User session.
- Refresh tokens.
- Email identity where applicable.
- WebAuthn/passkey registration and authentication.
- Credential lifecycle.
- Authentication events.
- Security events.

Must NOT:

- store blockchain private keys;
- sign blockchain transactions;
- determine arbitrary blockchain authorization solely from OAuth login.

---

## 5.2 Account Service

Responsibilities:

- Create Peridot Account.
- Create chain account records.
- Map user → Peridot Account.
- Map Peridot Account → chain accounts.
- Store public addresses.
- Store authority metadata.
- Track account status.
- Track deployment/initialization status.
- Resolve account for transaction intents.
- Manage account capabilities.
- Manage account-to-chain mapping.

Conceptual API:

```typescript
createAccount(userId)
getAccount(accountId)
getUserAccounts(userId)
createChainAccount(accountId, chain)
getChainAccount(accountId, chain)
```

---

## 5.3 Wallet Service

Responsibilities:

- Wallet initialization.
- Signing authority lifecycle.
- Fee payer lifecycle.
- Transaction preparation.
- Transaction signing orchestration.
- Transaction execution.
- Transaction status.
- Wallet state.
- Recovery metadata.
- Secure wallet credential management.

Conceptual API:

```typescript
wallet.create()
wallet.get()
wallet.getAccounts()
wallet.prepare(intent)
wallet.sign(request)
wallet.execute(request)
wallet.getTransactionStatus(signature)
```

The Wallet Service must NOT expose private keys through its public API.

---

## 5.4 Intent Service

Applications should express desired actions instead of constructing raw chain transactions.

Example:

```json
{
  "type": "TRANSFER_SOL",
  "accountId": "acc_123",
  "to": "destination",
  "amount": "1000000"
}
```

Flow:

```text
Intent
 ↓
Validate
 ↓
Resolve Account
 ↓
Apply Policy
 ↓
Chain Adapter
 ↓
Build Transaction
 ↓
Signing
 ↓
Submit
```

---

## 5.5 Policy Service

V1 policy scope:

- account active/inactive;
- authorized authority;
- allowed chain;
- transaction ownership;
- destination validation where applicable;
- amount validation where applicable;
- replay protection;
- nonce/recent blockhash handling.

Do NOT implement session keys yet.

---

## 5.6 Chain Adapter Layer

Interface:

```typescript
interface ChainAdapter {
  createAccount(input: CreateAccountInput): Promise<ChainAccount>;
  getAddress(accountId: string): Promise<string>;
  buildTransaction(intent: Intent): Promise<UnsignedTransaction>;
  signTransaction(
    transaction: UnsignedTransaction,
    signer: WalletSigner
  ): Promise<SignedTransaction>;
  sendTransaction(
    transaction: SignedTransaction
  ): Promise<TransactionResult>;
  getTransactionStatus(
    transactionId: string
  ): Promise<TransactionStatus>;
}
```

V1:

```text
SolanaAdapter
```

Future:

```text
EvmAdapter
BitcoinAdapter
SuiAdapter
AptosAdapter
...
```

---

# 6. Wallet Model

A Peridot Wallet is an abstraction.

```text
Peridot Wallet
 │
 ├── Peridot Account
 │
 ├── Solana Smart Account
 │      └── Solana fee payer authority
 │
 ├── EVM Smart Account (future)
 │
 └── other chain accounts
```

Do not expose implementation details unnecessarily to application developers.

---

# 7. Solana Account Architecture

## 7.1 Smart Account

The Smart Account is represented by a PDA controlled by the Peridot Solana program.

Example:

```text
PDA seeds:
["peridot", "account", account_id]
```

The PDA has no private key.

The program controls the PDA.

The program stores:

```text
account_id
authority
status
nonce
version
```

The exact schema must be finalized during implementation.

The authority representation is model-dependent and must be finalized in Phase 0:

```text
Ed25519 authority   → 32-byte public key
secp256r1 authority → 33-byte compressed / 64-byte uncompressed public key
```

Do not hardcode a 32-byte authority field if the selected authority model is secp256r1.

## 7.2 Important Solana Constraint

A PDA cannot directly act as a normal transaction fee payer because Solana requires the fee payer to be a signer holding SOL.

Therefore V1 requires:

```text
Smart Account
      +
Fee Payer Account
```

The fee payer:

- is user-controlled;
- holds SOL;
- signs the transaction;
- pays transaction fees;
- is NOT a server-owned treasury;
- is NOT a Peridot custodial account.

No gas sponsorship is permitted in V1.

---

# 8. Cryptographic Authorization

This is the most important security subsystem.

The system must separate:

```text
OAuth Identity
      ≠
Signing Authority
      ≠
Smart Account
      ≠
Fee Payer
```

## 8.1 OAuth

Google says:

```text
User authenticated as user_123
```

It does not sign blockchain transactions.

## 8.2 Signing Authority

The Smart Account stores an on-chain authority representation.

V1 implementation must support a cryptographic signing authority that can authorize operations.

The implementation should prefer a browser/device-controlled non-extractable signing mechanism where practical.

If WebAuthn/passkeys are used as the authorization mechanism, the Solana program must use the Solana secp256r1 verification facility or another explicitly supported cryptographic verification design. Solana provides native secp256r1 signature verification precompilation.

The implementation MUST NOT assume that a WebAuthn credential is automatically an Ed25519 Solana key.

## 8.3 Fee Payer

Because V1 has no sponsorship, the fee payer must be a valid Solana signer.

The SDK must abstract this from the application.

Application code should look like:

```typescript
await peridot.wallet.send({
  type: "TRANSFER_SOL",
  to,
  amount
});
```

The SDK handles the underlying fee payer signature.

---

# 9. Wallet Credential Architecture

The implementation must explicitly document where each secret exists.

## Server

Allowed:

```text
OAuth identity metadata
Passkey credential IDs
Passkey public keys
Wallet addresses
Account IDs
Encrypted wallet material if an encrypted embedded-key architecture is selected
Transaction metadata
Policies
```

Forbidden:

```text
Plaintext blockchain private key
Plaintext seed phrase
Unencrypted wallet secret
Server-side arbitrary signing authority
```

## Client / Authenticator

Preferred:

```text
Non-extractable signing credential
```

The implementation must use platform/browser secure storage where possible.

## Important V1 Design Decision

The coding agent MUST NOT silently implement a server-side encrypted private-key vault just to make Google login easy.

If the chosen architecture requires encrypted wallet key backup for seamless multi-device recovery, it must be explicitly documented as a separate security design and threat model before implementation.

---

# 10. Multi-Device Requirement

Target UX:

```text
Device A
Google login
 ↓
Peridot Wallet
 ↓
Wallet works

Device A lost

Device B
Google login
 ↓
Same Peridot Account
 ↓
Same Smart Account
 ↓
Recovery/credential restoration
 ↓
Wallet works
```

OAuth alone cannot cryptographically recover a blockchain signing secret.

Therefore the implementation must provide a dedicated wallet recovery mechanism.

V1 recovery requirements:

- multiple credentials can be registered;
- credential revocation;
- credential rotation;
- recovery flow must be explicit;
- OAuth authentication alone must NOT silently grant unilateral blockchain signing authority;
- lost-device recovery must not allow a compromised OAuth session to steal the wallet.

A future recovery phase may introduce social recovery/guardians.

---

# 11. Solana Program

Use Anchor unless there is a strong technical reason to use native Rust.

Suggested program structure:

```text
programs/
  peridot-smart-account/
    src/
      lib.rs
      state.rs
      errors.rs
      instructions/
        initialize.rs
        execute.rs
        update_authority.rs
        close.rs
```

## 11.1 Initialize

Creates/initializes the Smart Account PDA.

Concept:

```rust
pub fn initialize(
    ctx: Context<Initialize>,
    account_id: [u8; 32],
    authority: [u8; 32],
) -> Result<()> {
    let account = &mut ctx.accounts.smart_account;

    account.account_id = account_id;
    account.authority = authority;
    account.nonce = 0;
    account.version = 1;

    Ok(())
}
```

This is illustrative only. The production implementation must define the exact authority representation and validation mechanism. Note: a secp256r1 public key (33 bytes compressed / 64 bytes uncompressed) does not fit the 32-byte `authority` field shown above; the on-chain schema must match the authority model selected in Phase 0.

## 11.2 Execute

The program must:

1. verify authorization;
2. verify nonce/replay protection;
3. verify requested operation;
4. perform the allowed CPI;
5. increment nonce;
6. emit an event.

Concept:

```rust
pub fn execute(
    ctx: Context<Execute>,
    nonce: u64,
    action: Vec<u8>,
) -> Result<()> {
    require!(
        nonce == ctx.accounts.smart_account.nonce,
        PeridotError::InvalidNonce
    );

    // Verify authorization according to the selected authority model.

    // Validate action.

    // Execute authorized CPI.

    ctx.accounts.smart_account.nonce += 1;

    Ok(())
}
```

The implementation must NOT leave a placeholder authorization check in production.

---

# 12. Authority Verification Options

The coding agent must evaluate the following before finalizing the Solana authority model:

## Option A — Ed25519 authority

```text
User-controlled Ed25519 key
        ↓
Solana signature
        ↓
Smart Account authority
```

Pros:

- native Solana signing;
- simple transaction model.

Cons:

- multi-device/recovery requires a wallet-key backup/replication design.

## Option B — secp256r1/WebAuthn authority

```text
Passkey
 ↓
WebAuthn assertion
 ↓
secp256r1 signature
 ↓
Solana precompile verification
 ↓
Smart Account authorization
```

Pros:

- aligns with platform passkeys;
- private credential remains in authenticator;
- good UX.

Cons:

- WebAuthn assertion parsing and verification is substantially more complex;
- transaction message/challenge must be bound correctly;
- fee payer still needs a Solana-compatible signer;
- WebAuthn semantics must not be confused with Solana Ed25519 transaction signatures.

The implementation must choose one explicitly and document the security tradeoff.

---

# 13. Transaction Flow

## Standard transaction

```text
Application
 ↓
Peridot SDK
 ↓
Create Intent
 ↓
Account Service
 ↓
Resolve Solana Smart Account
 ↓
Policy validation
 ↓
Solana Adapter
 ↓
Build transaction
 ↓
Add user's fee payer
 ↓
User authorization/signing
 ↓
Submit to Solana RPC
 ↓
Confirm
 ↓
Return transaction result
```

## Example

```typescript
const result = await peridot.wallet.send({
  chain: "solana",
  action: {
    type: "TRANSFER_SOL",
    to: destination,
    amount: "1000000"
  }
});
```

Application should not need to manually serialize the Solana transaction.

---

# 14. Fee Flow — V1

Explicitly:

```text
User Smart Account
       │
       │ owns assets
       │
       ▼
Solana transaction
       │
       ├── User fee payer signs
       │
       └── User fee payer pays SOL
```

If the fee payer has insufficient SOL:

```text
Transaction fails.
```

Do not:

- sponsor;
- use Peridot treasury;
- use paymaster;
- automatically top up;
- implement Kora;
- hide the SOL requirement.

Gas sponsorship is a later milestone.

---

# 15. Database Model

Recommended initial tables:

## users

```text
id
status
created_at
updated_at
```

## oauth_identities

```text
id
user_id
provider
provider_subject
email
created_at
last_login_at
```

Unique:

```text
(provider, provider_subject)
```

## peridot_accounts

```text
id
user_id
status
version
created_at
updated_at
```

## chain_accounts

```text
id
account_id
chain_namespace
chain_reference
address
account_type
status
created_at
```

Example:

```text
solana / 4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z   (mainnet-beta; reference is the genesis-hash prefix)
eip155 / 1
eip155 / 8453
```

## authorities

```text
id
account_id
type
public_key
credential_id
status
created_at
last_used_at
```

## wallet_fee_payers

```text
id
chain_account_id
address
status
created_at
```

Do NOT store plaintext private keys here.

## transactions

```text
id
account_id
chain_account_id
intent_id
chain
network
tx_hash
status
created_at
confirmed_at
error_code
error_message
```

## intents

```text
id
account_id
type
payload
status
created_at
expires_at
```

## security_events

```text
id
user_id
account_id
event_type
metadata
created_at
```

---

# 16. API Design

## Auth

```text
POST /auth/oauth/:provider/start
GET  /auth/oauth/:provider/callback
POST /auth/logout
POST /auth/refresh
```

## Accounts

```text
POST /accounts
GET  /accounts
GET  /accounts/:id
GET  /accounts/:id/chains
```

## Wallet

```text
GET  /wallet
POST /wallet/initialize
POST /wallet/intents
POST /wallet/transactions/prepare
POST /wallet/transactions/submit
GET  /wallet/transactions/:id
```

## Credentials

```text
POST   /credentials/register/start
POST   /credentials/register/finish
POST   /credentials/authenticate/start
POST   /credentials/authenticate/finish
DELETE /credentials/:id
GET    /credentials
```

The exact API surface may change during implementation.

---

# 17. SDK

Create a first-party SDK.

Suggested packages:

```text
@peridot/id
@peridot/wallet
@peridot/solana
```

Potential unified package:

```text
@peridot/sdk
```

## Desired developer experience

```typescript
const peridot = await Peridot.connect({
  clientId
});

await peridot.auth.login();

const wallet = await peridot.wallet.get();

const accounts = await wallet.accounts();

const result = await wallet.send({
  chain: "solana",
  action: {
    type: "TRANSFER_SOL",
    to,
    amount: "1000000"
  }
});
```

The SDK must hide:

- transaction serialization;
- RPC details;
- Smart Account PDA derivation;
- authority verification details;
- blockhash management;
- confirmation polling;
- chain-specific instruction encoding.

The SDK must expose enough information for debugging and security audits.

---

# 18. Frontend Components

Create reusable UI components:

```text
<PeridotProvider />
<PeridotLogin />
<PeridotWallet />
<PeridotAccount />
<PeridotTransaction />
<PeridotSign />
```

Minimal user flow:

```text
Login
 ↓
Wallet
 ↓
Confirm transaction
 ↓
Success
```

No seed phrase screen.

No private-key export screen in V1.

No external wallet connection requirement.

---

# 19. RPC Architecture

Peridot does NOT need to operate its own Solana validator/node for V1.

Create an RPC abstraction:

```typescript
interface ChainRpc {
  getLatestBlockhash(): Promise<...>;
  sendTransaction(...): Promise<...>;
  getTransaction(...): Promise<...>;
  getBalance(...): Promise<...>;
}
```

Environment variables:

```text
SOLANA_RPC_URL
SOLANA_WS_URL
SOLANA_NETWORK
```

Environments:

```text
local
devnet
production
```

Production RPC provider must be configurable and replaceable.

Do not hardcode one RPC vendor into business logic.

---

# 20. Project Structure

Recommended monorepo:

```text
peridot-id/
├── apps/
│   ├── api/
│   ├── web/
│   └── docs/
│
├── packages/
│   ├── auth/
│   ├── account/
│   ├── wallet/
│   ├── intent/
│   ├── policy/
│   ├── crypto/
│   ├── sdk/
│   ├── solana/
│   └── shared/
│
├── programs/
│   └── peridot-smart-account/
│       ├── Anchor.toml
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs
│           ├── state.rs
│           ├── errors.rs
│           └── instructions/
│
├── tests/
│   ├── integration/
│   ├── e2e/
│   └── security/
│
├── infra/
│   ├── docker/
│   └── deployment/
│
├── docs/
│   └── prds/
│       └── PRD_v4.md
└── README.md
```

The coding agent should adapt this to the existing repository rather than blindly replacing the current structure.

---

# 21. Environment

## Local

```text
Peridot API
PostgreSQL
Redis if required
Solana local validator
Frontend
SDK
Anchor test environment
```

## Staging

```text
Peridot API
PostgreSQL
Solana Devnet
OAuth test applications
```

## Production

```text
Peridot API
PostgreSQL
Solana Mainnet
Production OAuth providers
Production RPC
```

Never use production credentials locally.

---

# 22. Security Requirements

## Mandatory

- OAuth state parameter.
- PKCE for public OAuth clients.
- Secure, HttpOnly, SameSite cookies where applicable.
- CSRF protection.
- Token rotation.
- OAuth provider account-linking protection.
- Credential registration authentication.
- Credential revocation.
- Replay protection.
- Transaction intent expiration.
- Transaction nonce protection.
- Strict origin validation.
- Strict signature verification.
- Strict chain/network validation.
- Strict account ownership validation.
- Rate limiting.
- Audit logs.
- Security event logs.
- Secrets in environment/secret manager.
- No plaintext blockchain private keys in logs.
- No private keys in analytics.
- No private keys in error messages.
- No private keys in database migrations.
- No private keys in source code.
- No signing authority in API logs.

## Critical

OAuth authentication must never be treated as equivalent to an arbitrary blockchain signature.

A valid Google login must not by itself allow the backend to manufacture an arbitrary transaction signature.

---

# 23. Threat Model

At minimum model:

1. Database compromise.
2. OAuth account takeover.
3. Session theft.
4. XSS.
5. Malicious browser extension.
6. Compromised device.
7. Lost device.
8. Credential theft.
9. Replay attacks.
10. Transaction substitution.
11. Malicious RPC.
12. Malicious application using Peridot SDK.
13. Smart contract bugs.
14. Upgrade authority compromise.
15. Phishing.
16. OAuth provider compromise.
17. Recovery abuse.

The security model must explicitly answer:

```text
Can a compromised Peridot API steal user assets?
```

Desired answer:

```text
No, not merely by database/API compromise.
```

---

# 24. Smart Account Security Rules

The Solana program must:

- verify authority;
- verify the exact message/action being authorized;
- prevent replay;
- maintain nonce/state;
- validate account PDA;
- validate program-derived seeds;
- validate target program/accounts;
- prevent arbitrary CPI if not intended;
- prevent unauthorized lamport withdrawal;
- prevent unauthorized token transfer;
- emit events;
- support controlled authority rotation;
- support program versioning;
- have upgrade authority secured.

Never implement:

```rust
if user_is_authenticated {
    execute();
}
```

On-chain code cannot trust Peridot's OAuth session.

On-chain authorization must be cryptographic.

---

# 25. Transaction Intent Security

Every sign request should bind:

```text
user/account
chain
network
smart account
action
destination
asset
amount
nonce
expiration
```

The signed payload must be domain-separated.

Example conceptual domain:

```text
PERIDOT
SOLANA
SMART_ACCOUNT
v1
```

This prevents a signature intended for one context from being replayed in another.

---

# 26. Smart Account Events

Emit events for:

```text
AccountInitialized
AuthorityUpdated
TransactionExecuted
TransactionRejected
NonceUpdated
AccountClosed
```

These events must be indexable for debugging and analytics.

---

# 27. Testing Requirements

## Unit Tests

- account derivation;
- PDA derivation;
- authority validation;
- nonce validation;
- transaction intent hashing;
- signature verification;
- OAuth state;
- PKCE;
- credential lifecycle.

## Program Tests

- initialize account;
- valid authorization;
- invalid authorization;
- invalid nonce;
- replay attack;
- unauthorized transfer;
- unauthorized CPI;
- authority rotation;
- malformed instruction;
- account mismatch.

## Integration Tests

```text
Google login
 ↓
Peridot account
 ↓
Solana account
 ↓
Prepare transaction
 ↓
Sign
 ↓
Submit
 ↓
Confirm
```

## E2E Test

A fresh user must be able to:

1. login;
2. obtain Peridot Wallet;
3. see Solana Smart Account;
4. receive SOL;
5. execute a transaction;
6. pay its own SOL fee;
7. see confirmed transaction;
8. logout;
9. login again;
10. access the same account.

---

# 28. Acceptance Criteria

V1 is complete when all are true:

### Identity

- [ ] Google login works.
- [ ] Discord login works.
- [ ] OAuth architecture supports additional providers.
- [ ] Peridot user ID is stable across providers when correctly linked.

### Wallet

- [ ] User sees one Peridot Wallet.
- [ ] No Phantom/MetaMask dependency.
- [ ] No seed phrase required.
- [ ] No private-key UI required.
- [ ] Solana Smart Account is deterministically resolvable.
- [ ] Wallet address can be displayed.

### Authorization

- [ ] Cryptographic authority exists.
- [ ] OAuth identity is not treated as a blockchain signature.
- [ ] Sign requests are bound to the correct account and chain.
- [ ] Replay is prevented.
- [ ] Credential lifecycle is implemented.

### Recovery / Multi-Device

- [ ] Multiple credentials can be registered for one account.
- [ ] Credential revocation works.
- [ ] Credential rotation works.
- [ ] A new device can recover the wallet via an explicit recovery flow (not OAuth-only).
- [ ] OAuth authentication alone does not grant signing authority on a lost device.

### Solana

- [ ] Program deployed to devnet.
- [ ] Smart Account initialization works.
- [ ] Authority validation works.
- [ ] Transaction execution works.
- [ ] SOL transfer works.
- [ ] SPL token transfer can be added only if architecture supports it cleanly.
- [ ] User fee payer pays transaction fees.
- [ ] No gas sponsorship.

### SDK

- [ ] Application can authenticate.
- [ ] Application can obtain wallet.
- [ ] Application can prepare transaction.
- [ ] Application can request signing.
- [ ] Application can submit transaction.
- [ ] Application can poll transaction status.

### Security

- [ ] No plaintext private key is stored server-side.
- [ ] No seed phrase is stored server-side.
- [ ] Database compromise does not directly reveal plaintext signing secrets.
- [ ] OAuth compromise alone cannot authorize arbitrary on-chain transactions without the wallet authorization mechanism.
- [ ] Program has replay protection.
- [ ] Program authority is protected.
- [ ] Upgrade authority is secured.

---

# 29. Implementation Phases

## Phase 0 — Architecture Lock

Deliver:

```text
ACCOUNT_MODEL.md
AUTHORITY_MODEL.md
WALLET_SECURITY_MODEL.md
```

Must answer:

- What is the signing authority?
- How is it generated?
- Where is it stored?
- How does a second device obtain authorization?
- How does recovery work?
- How is the Solana fee payer managed?
- How does the program verify authorization?

Do not write production smart-account code before these are resolved.

---

## Phase 1 — Identity

Implement:

- OAuth/OIDC;
- Google;
- Discord;
- session;
- account linking;
- security events.

Deliver:

```text
Login → Peridot User
```

---

## Phase 2 — Account Model

Implement:

- Peridot Account;
- chain accounts;
- Solana account records;
- authority records;
- account API.

Deliver:

```text
User
 ↓
Peridot Account
 ↓
Solana Smart Account address
```

---

## Phase 3 — Cryptographic Authorization

Implement the selected authority mechanism.

Requirements:

- generation/registration;
- signing;
- verification;
- credential lifecycle;
- secure client storage;
- multi-device design;
- recovery design.

This phase must pass security tests before on-chain asset movement.

---

## Phase 4 — Solana Smart Account Program

Implement:

- initialize;
- authority storage;
- authority verification;
- nonce;
- execute;
- controlled CPI;
- events;
- authority rotation;
- security tests.

Deploy to local validator.

Then devnet.

---

## Phase 5 — Solana Wallet SDK

Implement:

```text
connect()
getWallet()
getAccount()
prepare()
sign()
send()
confirm()
```

The SDK should hide chain-specific implementation details.

---

## Phase 6 — End-to-End Transaction

Complete:

```text
Google
 ↓
Peridot ID
 ↓
Peridot Wallet
 ↓
Smart Account
 ↓
User authorization
 ↓
Fee payer
 ↓
Solana
 ↓
Confirmation
```

Test with real devnet SOL.

---

## Phase 7 — Production Hardening

Before mainnet:

- security audit;
- program audit;
- dependency audit;
- OAuth security review;
- threat-model review;
- key/credential review;
- RPC failover;
- rate limiting;
- observability;
- alerting;
- backup/restore;
- incident response;
- program upgrade controls.

---

# 30. Definition of Done

The V1 implementation is considered successful when a developer can write:

```typescript
const peridot = await Peridot.connect({
  clientId: "..."
});

await peridot.auth.login();

const wallet = await peridot.wallet.get();

const result = await wallet.send({
  chain: "solana",
  action: {
    type: "TRANSFER_SOL",
    to: "DESTINATION",
    amount: "1000000"
  }
});

console.log(result.signature);
```

and the end-user experience is:

```text
Login with Google
        ↓
Peridot Wallet appears
        ↓
User has Solana Smart Account
        ↓
User has SOL
        ↓
User initiates transaction
        ↓
Peridot performs cryptographic authorization
        ↓
User's fee payer pays SOL fee
        ↓
Smart Account executes
        ↓
Transaction confirmed
```

No external wallet extension is required.

No seed phrase is required.

No private-key UI is required.

Peridot does not hold a plaintext user private key.

Gas sponsorship is not part of V1.

---

# 31. Future Architecture — Explicitly Deferred

After V1 is stable, the architecture must be able to add:

```text
Gas Sponsorship
      ↓
Session Keys
      ↓
Recovery / Guardians
      ↓
Multi-device policies
      ↓
EVM Smart Accounts
      ↓
Additional chains
```

The V1 code must therefore avoid hardcoding assumptions that:

```text
chain == Solana
account == Ed25519 wallet
wallet == native wallet
authority == one permanent key
```

The core abstraction must remain:

```text
Peridot Identity
      ↓
Peridot Account
      ↓
Chain Account
      ↓
Authorization
      ↓
Chain Execution
```

---

# 32. Important Implementation Rule for OpenCode

OpenCode must NOT blindly implement ambiguous security-critical behavior.

When encountering an unresolved design choice involving:

- private-key handling;
- signing authority;
- recovery;
- passkey/WebAuthn;
- smart-account authorization;
- Solana fee payer;
- transaction authorization;
- program upgrade authority;

the agent must stop at the relevant phase, document the decision, and follow this PRD's security constraints.

Never "temporarily" implement server-side private-key custody merely to make tests pass.

Never use mock authorization in production code paths.

Mocks are allowed only in unit tests with clear test-only boundaries.

---

# 33. Final Architecture

```text
                              PERIDOT ID
                                  │
                  ┌───────────────┼────────────────┐
                  │               │                │
                  ▼               ▼                ▼
              OAuth/OIDC     Auth/Credentials   Account Service
                  │               │                │
                  └───────────────┼────────────────┘
                                  ▼
                           Peridot Wallet
                                  │
                         ┌────────┴────────┐
                         ▼                 ▼
                   Smart Account       Fee Payer
                         │                 │
                         │                 └── SOL
                         │
                         ▼
                  Solana Program
                         │
                         ▼
                      Solana
```

The central architectural rule is:

```text
OAuth proves identity.
Cryptographic authority authorizes.
Smart Account executes.
Fee payer pays.
Blockchain owns the final state.
Peridot orchestrates the experience.
```

This is the foundation for Peridot ID to become the wallet, identity, and account-abstraction gateway for the entire Peridot ecosystem.
