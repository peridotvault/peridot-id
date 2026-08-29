# PRD v5 — PeridotID Smart Wallet

**Version:** 5.0
**Status:** Draft
**Supersedes:** PRD_v4 where they conflict (program framework, instruction set)
**Builds on:** ADR 003–007, `apps/api` wallet module (record-only), `packages/sdk-js`

**Naming:** the project is **PeridotID** (repo/package scope `peridot-id`), short name
**`pid`** — already the on-chain identity format (`pid_<ULID>`). Use "PeridotID" in
product copy; "Peridot" alone refers to the wider ecosystem.

---

## 1. Objective

PeridotID provides a free, non-custodial Solana Smart Wallet for every user — the wallet
layer of the Peridot gaming identity platform.

The wallet is created when the user performs their first top-up; the user pays the required
on-chain account creation (rent) and transaction costs themselves.

Peridot provides the identity and wallet infrastructure without holding the user's private
keys and without subsidizing wallet creation.

---

## 2. Core Model

```text
One PeridotID → One Smart Account (PDA) → Many Token Accounts (ATAs)
```

```text
PeridotID
   │
   ▼
Smart Account PDA          ← owns the assets, controlled by the Peridot program
   │
   ├── SOL
   ├── USDC ATA
   ├── BONK ATA
   └── Other SPL Token ATAs

Fee Payer (separate)       ← device-held Ed25519 keypair, pays transaction fees, owns nothing else
Authority (separate)       ← secp256r1 passkey, authorizes withdrawals
```

Four things never collapse into one (PRD_v4 §8, ADR 005/006):

```text
OAuth Identity ≠ Signing Authority ≠ Smart Account ≠ Fee Payer
```

---

## 3. Core Flow

### First top-up (wallet activation)

```text
User
 ↓
PeridotID Login (Google OAuth)
 ↓
No Smart Account yet
 ↓
User selects Top Up
 ↓
topup(amount)
 ↓
One transaction:
 ├── Peridot Program: initialize Smart Account PDA (authority = user's passkey)
 └── Deposit funds into the Smart Account
 ↓
Smart Account Active
```

The user pays:

- account creation / rent cost;
- transaction fee (from the user's fee payer — see §7).

Any remaining SOL becomes the user's Smart Account balance:

```text
1 SOL
 ├── Account creation/rent
 ├── Transaction fee
 └── Remaining SOL → User Smart Account
```

Peridot does not subsidize Smart Account creation.

### Existing wallet

```text
User
 ↓
topup(amount)
 ↓
Existing Smart Account
 ↓
Deposit
```

Each PeridotID keeps using the same primary Smart Account. A top-up must never create a
second account.

---

## 4. Deposits & Token Accounts

**Deposits are plain transfers — not program instructions.**

A PDA receives SOL via a normal System Program transfer, and SPL tokens via a normal Token
Program transfer. No custom program instruction is needed to move funds *into* the Smart
Account. Only initialization and withdrawals touch the Peridot Program (§5).

Peridot must not create ATAs for every token during wallet creation. ATAs are created on
demand, when the user first deposits a specific SPL token, using the Associated Token
Account program's idempotent creation:

```text
topup(USDC, 100)
 ↓
USDC ATA does not exist
 ↓
Same transaction:
 ├── create_idempotent USDC ATA (owner = Smart Account PDA)
 └── Transfer 100 USDC
```

If the ATA already exists, the transaction is just the transfer. The same approach applies
to BONK and any other SPL token.

---

## 5. Solana Program

Create a custom Solana Program using **Pinocchio**.

> Framework note: ADR 007 originally locked Anchor. The stakeholder overrode this to
> Pinocchio (recorded as an ADR 007 amendment): the instruction surface is tiny
> (initialize + withdrawals + authority rotation), Pinocchio's minimal compute-unit
> footprint matters at gaming transaction volume, and Anchor's account-validation
> machinery is not needed at this size.

The program supports exactly:

- `initialize_account` — create the Smart Account PDA, record the authority, set
  nonce = 0, version = 1. Anyone may pay rent for creation, but the recorded authority is
  fixed at creation and comes from the authenticated registration flow.
- `withdraw_sol(amount)` — move SOL out of the Smart Account. Requires passkey
  authorization (§6).
- `withdraw_token(mint, amount)` — move SPL tokens out of the Smart Account. Requires
  passkey authorization (§6).
- `update_authority(new_authority)` — authority rotation/revocation; authorized by a
  current valid authority (ADR 006).

**No `topup` instructions exist** — deposits are plain transfers (§4).

The program must:

- initialize the Smart Account using a deterministic PDA
  (seeds: `["peridot_id", "account", account_id]`, ADR 004/007);
- associate the Smart Account with the user's PeridotID;
- verify secp256r1 passkey authorization on every withdrawal via the native secp256r1
  precompile, with the WebAuthn challenge bound to the domain-separated payload
  (`PERIDOT | SOLANA | SMART_ACCOUNT | v1`, PRD_v4 §25);
- maintain an on-chain nonce for replay protection;
- never perform arbitrary CPI — only the System/Token Program transfers above;
- prevent unauthorized users from accessing another user's assets;
- emit indexable events (`AccountInitialized`, `AuthorityUpdated`, `TransactionExecuted`,
  `TransactionRejected`, `AccountClosed`).

---

## 6. Authorization

**Resolved — ADR 005 Option B, stakeholder decision.** This section replaces v5's earlier
"to be defined" placeholder.

### Authority: secp256r1 passkey

The Smart Account's asset-controlling authority is a **platform passkey** (WebAuthn,
secp256r1):

- **non-extractable** — the secret never leaves the authenticator;
- **platform-synced** — iCloud/Google passkey sync provides multi-device recovery with no
  Peridot-built key backup;
- **phishing-resistant** — origin binding is built into WebAuthn.

On-chain, the program verifies the passkey's secp256r1 signature through Solana's native
secp256r1 precompile (instruction introspection), with the WebAuthn challenge
cryptographically bound to the domain-separated Solana payload. A passkey assertion *is*
the withdrawal authorization.

### Fee payer: Ed25519 device key

A passkey cannot pay Solana transaction fees — fees require an Ed25519 signer. Each device
therefore generates a separate **Ed25519 fee-payer keypair**, stored in platform secure
storage (ADR 006):

- it pays transaction fees and holds only fee SOL;
- it is user-controlled — never a Peridot treasury, never sponsored;
- **blast radius of compromise is fee SOL only** — assets sit in the Smart Account, gated
  by the passkey authority, not by the fee payer.

### V1 on-chain verification — secp256r1 passkey (ADR 005 Option B)

The asset-controlling authority is verified **on-chain as a secp256r1 passkey**: the SDK
places a Solana Secp256r1 precompile instruction right after the program instruction; the
program introspects it via the Instructions sysvar and verifies the recovered public key
equals the registered authority, that the signed message binds the exact `clientDataJSON`,
and that its WebAuthn challenge equals the domain-separated authorization payload
(nonce ‖ action ‖ expiry). Expiry + on-chain nonce give replay protection, and the
challenge binding prevents transaction substitution. The program was initially built with
an Ed25519 signer fallback (ADR 005's documented fallback), then **reverted to full passkey
verification** when the `pinocchio-secp256r1-instruction` crate made the precompile
introspection pattern available in Pinocchio (recorded in ADR 005 / task 004).

### Login: Google OAuth — unchanged

The passkey does **not** replace Google login. Authentication stays exactly as implemented
today (`apps/api`): OAuth 2.0 via **Google**, HttpOnly cookie session (access + rotating
refresh token) saved on the device. More OAuth providers (Discord, etc.) plug into the
same provider architecture later (PRD_v4 §5.1) — Google is the V1 provider, not the only
one forever.

### Multi-device

One PeridotID account works on every device the user owns:

```text
Register with Google on laptop
 ↓
Same Google account → login on PC, phone, tablet
 ↓
Same pid, same Smart Account — each device gets its own session
```

- **Login** on a new device = normal Google OAuth. No limit on devices per account.
- **Wallet authority** on a new device comes from (ADR 006 §4):
  1. **platform passkey sync** (iCloud/Google) — the primary path, no Peridot machinery;
  2. **registering an additional passkey** on the new device, approved by an existing
     valid credential — for cross-platform cases sync doesn't cover.
- A fresh Google login alone is necessary but **never sufficient** to move assets — the
  device must also hold a registered passkey. OAuth cannot steal the wallet.

### OAuth is not signing

Google login proves identity. It must never, by itself, authorize an on-chain operation
(PRD_v4 §22 Critical). On-chain authorization is always cryptographic (the passkey).

### Future chains

The same passkey model carries forward: EVM smart accounts verify secp256r1 passkeys via
the same WebAuthn flow (RIP-7212-style precompile). One passkey, every chain — chain
adapters absorb the differences (PRD_v4 §5.6).

---

## 7. First Top-Up Bootstrap

The first transaction needs a fee payer that already holds a small amount of SOL.
In V1:

- the user's fee-payer address is shown in the wallet UI before activation;
- the user funds it from an external source (exchange, friend, another wallet) — V1 has
  no fiat on-ramp and no sponsorship;
- insufficient fee-payer SOL → the transaction fails honestly, with a visible message
  (ADR 006 §3).

Because the Smart Account PDA is deterministic, it can also *receive* funds before
initialization; initialization then claims the address and records the authority in the
same transaction as the first structured top-up.

---

## 8. User Ownership

Peridot must never hold the user's private key.

The Smart Account is designed so that Peridot cannot unilaterally move or withdraw user
assets: the server stores only public material (addresses, passkey public keys and
credential IDs, account IDs, transaction metadata — ADR 006 §1).

The Peridot backend must not have direct access to user funds.

Threat-model answer (PRD_v4 §23): **a compromised Peridot API cannot steal user assets** —
there is no key material to steal, and the program verifies authority cryptographically
on-chain.

---

## 9. Client & SDK

**One client codebase: Expo (React Native + Expo web) for both mobile and web.** There is
no separate website to build — Expo web renders the same app to the browser.

```text
packages/sdk-js             ← pure TypeScript core SDK (existing package, extended)
   │
apps/wallet (Expo)          ← one codebase:
   ├── iOS / Android        ← native via React Native
   └── Web                  ← same code via Expo web (react-native-web)

Chrome extension (future)   ← thin shell over the sdk-js core, not the Expo app
```

- The SDK core stays pure TypeScript and runs everywhere; platform differences (passkey
  APIs, secure storage) live behind small adapters.
- **Expo, not Tauri** — Expo is mature, TypeScript-native (matches the team), and has
  working passkey and Solana mobile tooling; and unlike Tauri it covers web + iOS +
  Android from one codebase. Tauri is only reconsidered if a desktop-native app ever
  becomes a real requirement (YAGNI).
- A Chrome extension is a plain web environment: it consumes the sdk-js core directly
  (WebAuthn works in extension pages). Deferred past V1 — designed for, not built.

### Platform adapters

| Concern | Expo web | Expo iOS/Android |
|---|---|---|
| Login | Google OAuth redirect, cookie session (existing flow) | Same OAuth flow via web browser session, cookie/token saved on device |
| Passkey (authority) | WebAuthn API | React Native passkey module (platform authenticators) |
| Fee-payer storage | Non-extractable WebCrypto where practical | Expo SecureStore / OS keystore |

### Developer experience

```ts
await peridot.wallet.topup({ amount: "1", asset: "SOL" });
await peridot.wallet.topup({ amount: "100", asset: "USDC" });
await peridot.wallet.withdraw({ amount: "50", asset: "USDC", to: destination });
```

Developers never handle PDA derivation, ATA creation, precompile introspection, blockhash
management, or confirmation polling. The SDK hides these and exposes enough information
for debugging and security audits (PRD_v4 §17).

---

## 10. V1 Requirements

### Must Have

- Custom Solana Program using **Pinocchio**
- One Smart Account PDA per PeridotID
- First top-up initializes the Smart Account
- SOL deposits (plain transfer)
- SPL token deposits (plain transfer + on-demand idempotent ATA creation)
- SOL withdrawals (`withdraw_sol`, passkey-authorized)
- SPL token withdrawals (`withdraw_token`, passkey-authorized)
- secp256r1 passkey authority (ADR 005 Option B) + Ed25519 device fee payer (ADR 006)
- Google OAuth login with device-saved sessions; multi-device login on one account
- One Expo client serving web + iOS + Android, built on the `@antigane/sdk-js` core
- Authorization and security validation
- Devnet testing
- Mainnet deployment

### Not Required for V1

- Multi-chain support (EVM and others via future adapters)
- Social recovery / guardians
- Multisig
- Complex bundler infrastructure
- Gas sponsorship / paymaster
- Fiat on-ramp
- Token swaps
- NFT marketplace
- Desktop app (Tauri or otherwise)
- Chrome extension (designed for — thin shell over the SDK core — but shipped later)
- Additional OAuth providers beyond Google (Discord etc. — architecture supports them)
- External security audit

---

## 11. Business Model

PeridotID and Peridot Wallet are free for users.

Users are responsible for their own on-chain costs, including initial account creation and
transaction fees. Peridot does not charge users for creating a wallet.

Potential future revenue sources:

- gaming infrastructure;
- Peridot ecosystem services;
- marketplace fees;
- swap/payment integrations;
- on/off-ramp partnerships;
- optional developer infrastructure.

Monetization is not part of V1.

---

## 12. Success Criteria

V1 is successful when:

- A user can log in with PeridotID (Google OAuth).
- The same Google account logs in on multiple devices and sees the same wallet.
- A user without a Smart Account can perform their first top-up.
- The Smart Account is automatically initialized in that transaction.
- The deposited funds arrive in the Smart Account.
- The user can see their Smart Account address.
- The user can receive USDC, BONK, and other supported SPL tokens.
- Token accounts are created automatically when needed.
- The user can withdraw their assets using passkey authorization.
- The user pays their own fees through their device fee payer.
- Peridot does not need to provide SOL for every new user.
- All wallet operations are verifiable on-chain through the Peridot Program.
- The same flow works on web and mobile from the single Expo client.

---

## Core Principle

**One PeridotID → One Smart Account → Many Token Accounts.**

Peridot provides the wallet infrastructure for free; users fund their own on-chain
accounts; passkeys authorize; the fee payer pays; the blockchain owns the final state.

---

## References

- PRD_v4 (base architecture, security model, threat model)
- ADR 003 (custody & record-only wallet history)
- ADR 004 (account model, PDA derivation)
- ADR 005 (signing authority — **accepted: secp256r1 passkey**)
- ADR 006 (fee payer, no sponsorship, recovery)
- ADR 007 (Solana program — **amended: Pinocchio**)
