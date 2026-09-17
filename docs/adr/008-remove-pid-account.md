# ADR 008 — Remove PidAccount: 1 Identity = 1 Personal Wallet

Status: accepted

Supersedes the `PidAccount` hub of ADR 004. ADR 004 stays as the historical record of
why the hub existed; this ADR records why it was removed.

## Context

Business rule (not a technical limitation): **1 identity owns exactly 1 personal
wallet.** The `PidAccount` table contributed three things:

1. A UUID whose only load-bearing output was 32 seed bytes for PDA/CREATE2 derivation.
2. An ownership hop (`ownedAccount`/`ownedSolanaRow`/`ownedRow`) between the JWT pid
   and the wallet rows.
3. Two dead fields (`status`: filter-only/write-never; `version`: echo-only).

Every `accountId` FK (authorities, challenges, intents, transactions, security events)
only ever received an already-resolved id. No query needed plural rows.

## Decision

- Delete `PidAccount`. All wallet-owned rows reference `Identity.pid` directly.
- PDA/CREATE2 seeds become `sha256(lowercased pid)` (uniform opaque 32B; the handle
  never leaks on-chain). All existing derived addresses change; stored rows re-derive.
- Routes collapse to singular `/v1/account/...` (no account ids in URLs — the IDOR
  class disappears with the parameter). `AccountView` envelope deleted; endpoints
  return `ChainAccountView[]`.
- `SecurityEvent.accountId` dropped (pid is the scope).
- Explicitly out of scope: multisig and multi-wallet. A future multisig product will
  be a **separate wallet model** shared by many identities — no hooks, no nullable
  owner columns, and no "future-proof" scaffolding are left behind for it here.

## Consequences

- Passkeys authorize the identity's wallet (`authorities.pid`); per-wallet key scoping
  is gone because there is only one wallet. (V4 note, 2026-09-16, ADR 009: the
  single wallet remains, but scoped keys reappear *inside* it on EVM —
  `sessions[permissionId]` with kind/target/caps/expiry — not as extra wallets.)
- Devnet/test-fund addresses derived from UUID seeds go stale (no real funds at risk).
- Migration `20260915000000_remove_pid_accounts` backfills `pid` through the old hub,
  so the rename is lossless on populated databases.
