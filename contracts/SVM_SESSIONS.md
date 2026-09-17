# PeridotID SVM Session Layer (canonical)

Status: **canonical spec** alongside `contracts/V2_AUTHORIZATION.md` (V3 paths
frozen) and `contracts/V4_PERMISSIONS.md` (EVM-only). This document is the SVM
counterpart of the permission goal — a fundamentally different security
boundary, not a port. Nothing here shares code, keys, nonces, or trust
assumptions with the EVM layer (see §7).

Core invariant (never weaken):

> The vault PDA that holds economic value never enters a game-targeting CPI —
> not as signer, not as writable, not at all. Gameplay CPIs are signed solely
> by a structurally separate session PDA holding rent-exempt minimum only.

## 1. Roles

- **OWNER** = the P-256 passkey (`authority` in the 112B vault record). Unchanged.
- **SESSION key** = an Ed25519 keypair registered per session. Solana
  transactions require Ed25519 envelope signatures and the P-256 precompile is
  not CPI-callable, so P-256 authorizes registration once (via the precompile,
  0-CU + one 5,000-lamport signature fee) and gameplay authorization is the
  session key signing the envelope plus on-chain record checks. No P-256
  ceremony and no precompile cost per gameplay action — affordable by construction.

## 2. Accounts and layouts

- Vault PDA: `["peridot_id", "account", sha256(pid)]` (existing, 112B state).
- Session PDA: `["peridot_id", "session", account_id, session_pubkey]`,
  program-owned, fixed 205B record:
  `version u8 ‖ status u8 ‖ session_pubkey[32] ‖ account_id[32] ‖
  expires_at i64LE ‖ last_used i64LE ‖ seq u64LE ‖ allowed_program[32] ‖
  recorded_authority[32] ‖ recorded_has_authority u8 ‖ recorded_slot u64LE ‖
  last_seen_authority[32] ‖ last_seen_has_authority u8 ‖ last_seen_slot u64LE ‖
  bump u8`.
- One session pubkey ⇒ one PDA (one account, one permission). The session PDA
  holds exactly the rent-exempt minimum; the program creates it (a PDA cannot
  sign a client-side create) and only the owner reclaims it.

## 3. Instructions (discriminators 7–10, domain `PID|SOLANA|SESSION|v1`)

- `register_session` (7), owner P-256: binds session key + one allowlisted game
  + verified upgrade snapshot + `expires_at ≤ now+24h`; consumes the owner
  nonce. Accounts: vault `[WRITE]`, session PDA `[WRITE]` (must not exist),
  instructions sysvar, upgrade evidence, game program, payer `[SIGNER]`,
  system program.
- `session_execute` (8), session Ed25519 (`is_signer` + key match): strict
  `seq`, hard expiry (24h) + inactivity (30min) on the chain `Clock`,
  allowlist match, self-call block, vault-absence enforcement (derived
  on-chain), ≥1 session-signer meta naming the session PDA, exact account
  count (**`remaining_accounts` rejected**), protected-account pre/post
  invariant checks, upgrade-visibility refresh. No fee split: the session
  holder pays their own transaction fee.
- `revoke_session` (9), owner P-256: immediate `revoked` flip, owner nonce.
- `close_session` (10), owner P-256: revoked-or-expired only, rent to an
  owner-bound destination, owner nonce.

Payloads (`sha256`, LE): register `SESSION‖0x07‖account‖nonce‖session_key‖
program‖expires_at‖rec_has_auth‖rec_auth‖rec_slot‖expiry`; revoke
`SESSION‖0x09‖account‖session_key‖nonce‖expiry`; close `SESSION‖0x0A‖account‖
session_key‖destination‖nonce‖expiry`. Execution itself is Ed25519-authorized
(no P-256 payload) with strict per-session `seq`.

## 4. Upgrade visibility (record-and-log, owner-accepted risk)

Loader classes (read from the game program's owner): upgradeable-loader
programs carry a `ProgramData { slot, upgrade_authority }` account which is
derived, loader-ownership-checked, parsed (45-byte metadata: variant u32 +
slot u64 + one-byte COption tag — verified against chain truth), and matched
to the owner-signed snapshot at registration; `last_seen_*` refreshes every
execution for backend indexers. Native/deprecated-loader programs are
immutable by construction (no ProgramData): evidence is the program itself,
snapshot is empty. Unknown loaders fail closed. There is deliberately **no
enforcement** on post-registration change: an upgraded allowlisted game keeps
its session scope, visibly (ADR-010 §4).

## 5. Adversarial guarantees (proven §8, all against live validator)

| Threat | Enforcement | Proven by |
|---|---|---|
| Vault drain via game CPI | vault address derived on-chain and rejected in metas and accounts | vault-in-CPI 0x15 + balances |
| Signer forwarding to third program | session-PDA signer reusable downstream, but moves only session-owned value; vault absent/unsigned | forwarded drain bounded + vault immune |
| Session SOL theft (incl. forwarded) | system program debits only data-less accounts — session record makes its SOL structurally immobile | system-debit fails closed |
| Approval/authority hijack | protected pre/post hash-pin (owner, lamports, data) + explicit delegate/close_authority compare | 0x15 with balance unchanged |
| Vault token movement | token program requires vault signature, never lent | transferFrom fails, balances |
| Replay / stale seq | strict per-session `seq` | 0x14 replay |
| Expired / inactive / revoked use | chain-clock expiry + inactivity + status flag | 0x13 / 0x12 |
| Account substitution | exact account count, no `remaining_accounts` | extra-account rejection |
| Lied upgrade snapshot | registration matches snapshot to chain truth | 0x15 at registration |
| Rent theft on close | revoked-or-expired only, owner-bound destination | close tests |

## 6. Preserved invariants

Deterministic derivation from PID (vault + session seeds); passkey is ultimate
owner authority (every lifecycle transition is owner-signed except
session-signed executions inside scope); relayer untrusted (registration is
fully-bound owner intent; gameplay needs no relayer at all); no changes to the
7 existing instructions, state layout, fee model, or backend bake-in.

## 7. EVM interop (explicit, no conflation)

Shared vocabulary only: grant→execute→revoke lifecycle, scope-kind thinking,
TTL philosophy, fee-split pattern on owner paths, `POST */grants/validate`
backend shape. Separate: domains/payloads/counters (owner-nonce vs
per-session `seq` are different counters), key types (P-256 sessions on EVM vs
Ed25519 on SVM), and the core guarantee itself — EVM: one account plus
exact-call construction; SVM: two-PDA isolation plus upgrade-pinned allowlist.
Session keys are never portable across chains. A single backend
`permissions`-style module may serve both only behind per-chain policy
adapters.

## 8. Proven vs architectural claim (pre-audit)

Proven (evidence: 27 host unit tests, 24 validator session cases, 37 existing
integration cases, SDK/ backend specs): the table in §5 for single-CPI scope,
domain disjointness, revocation immediacy, rent-exact creation/reclaim,
loader-class handling incl. immutable programs, SDK↔program byte parity via
independent reimplementation. Architectural claim (needs external human audit
before immutability/mainnet): Token-2022 extension interactions beyond base
authority fields, CU/griefing bounds of hostile game CPIs, upgrade-visibility
sufficiency under the no-enforcement policy, inactivity-window adequacy for
real games, backend indexer coverage of `last_seen_*` drift. **Do not deploy
to mainnet or burn upgrade authority on this basis alone.**
