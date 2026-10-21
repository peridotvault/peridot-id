# ANT-330 — Audit scope & acceptance criteria: public and developer UX

Parent: ANT-219 (Audit Public & Developer UI/UX). This document is the Phase-0
scope gate: it defines WHAT gets audited, HOW pass/fail is judged, and WHAT IS
OUT. Audit execution (screenshots, findings, fix backlog) happens under ANT-219,
not here.

Repo: `peridotvault/peridot-id`. Branch for this scope: `pc/peridot-audit-scope-330`,
base `paperclip`. No code changes in this scope — spec only.

## 1. Context & goal

PeridotID has two distinct UX consumers sharing auth/payment primitives:

- **End users** in `apps/wallet` (login, home, send/receive/swap/topup,
  activity, approve/consent, settings).
- **Developers** in `apps/dashboard` (apps list, app detail/settings, chains,
  contracts, fees, partners, demo).

Goal: a repeatable audit that proves a user or developer can complete their
primary workflows **without confusion**, with consistent visuals, and with
correct loading/empty/error states — and that cosmetic-only churn is explicitly
excluded so engineers are not handed redesigns disguised as audits.

Domain lenses applied (cited by name): **INVEST** (each checklist row is an
independent, testable story), **SMART acceptance criteria**, **Given-When-Then**
scenarios, **Happy-path vs sad-path** parity, **Edge-case enumeration**,
**Contract-first APIs** (workflow completion contracts defined before findings),
**Backward compatibility**, **MVP slicing**, **Non-functional requirements**,
**Dependency mapping**.

## 2. Scope IN (surface → implementation map)

| # | Surface (ticket language) | Where implemented (evidence) |
|---|---------------------------|------------------------------|
| S1 | Authentication screens | `apps/wallet/src/screens/LoginScreen.tsx`, `ProvisioningScreen.tsx`, `feat/auth/components/` (`LoginOptions`, `EmailOtpForm`, `PidClaimForm`, `SsoConsentModal`, `PopupReview`), `feat/auth/popup-login.ts`, `feat/auth/sso.ts` |
| S2 | User dashboard | `apps/wallet/src/screens/HomeScreen.tsx`, `ProfileScreen.tsx`, `feat/wallet/components/` (`HomeHeader`, `BalanceCard`, `AssetSection`, `QuickActions`, `TopBar`), shared `TabBar`, `AppColumn` |
| S3 | Wallet pages | `SendScreen`, `ReceiveScreen`, `SwapScreen`, `TopupScreen`, `ActivationScreen` + `DepositAddressCard`, `DepositCardList`, `SendChoiceModal`, `SolActivationModal`, `ActivationStatusCard` |
| S4 | Transaction history | `ActivityScreen`, `ActivityDetailScreen`, `FiatDetailScreen`, `FiatTransferScreen`, `FiatLedgerDetailScreen`, `feat/fiat/components/FiatQuoteBreakdown.tsx` |
| S5 | Payment confirmation | `ApproveScreen` (popup/SSO consent + sign approval), `SendScreen` review step, `FiatTransferScreen` confirm step |
| S6 | Developer dashboard | `apps/dashboard/App.tsx` routes `/`, `/apps/:id`, `/chains`, `/chains/create`, `/chains/edit`, `/contracts`, `/fees`, `/partners`, `/demo` + `src/workspace/*` managers + `src/routes/*` |
| S7 | Application settings | Dashboard `app-detail-page` (redirect URIs, chains, contracts, fees), `chains-create/edit` forms, wallet `SettingsScreen`, `EditProfileScreen`, `PasskeyScreen`, `SessionsScreen`, `ConnectedAccountsScreen`, `AppConnectionsScreen` |

Any screen reachable from the wallet `Screen` union (`App.tsx`: login, home,
approve, send, receive, swap, topup, provisioning, passkey, settings, profile,
edit-profile, sessions, connected-accounts, app-connections, activity,
activity-detail, fiat-detail, fiat-transfer, fiat-ledger-detail, activation)
or the dashboard route table above is IN. Anything else (API internals, CLI,
contracts code) is OUT of this audit.

## 3. Scope OUT (cosmetic-only — explicitly excluded)

The following MUST NOT appear as audit findings unless tied to a numbered AC
below (confusion, error, or blocked workflow):

1. Font-family / type-scale restyling with no readability defect.
2. Color/brand restyle, border-radius, shadow, or illustration swaps.
3. Icon-set swaps where the current icon is unambiguous and labelled.
4. Marketing-copy rewrites and tone edits (unless the copy causes a U/D
   workflow failure — then it is filed under U7/D1 confusion, not copy taste).
5. Animation/transition polish with no state-communication function.
6. Layout rearrangements that do not fix a navigation, responsive, or
   accessibility failure.
7. New features, new screens, new settings fields.

Rule: every finding must cite the AC id it violates (C1–C8 or W-U/D below).
"No-AC findings" are rejected at triage.

## 4. Audit dimensions (checklist C1–C8)

Each dimension applies to every surface S1–S7 unless noted. Verdict per cell:
pass / fail (with route + screenshot + AC citation) / N/A (with reason).

- **C1 Usability:** primary action is visible without scrolling on the target
  viewport; destructive actions require explicit confirm; no dead buttons.
- **C2 Navigation:** every screen has a labelled way back/forward; tab bar (wallet)
  and topbar (dashboard) highlight the active location; deep links and
  `*` → NotFound (dashboard) behave sanely.
- **C3 Visual consistency:** spacing/type/buttons/inputs match shared primitives
  (`shared/primitives.tsx`, `UIButton`, `BottomSheet`, `theme.ts`, dashboard
  `workspace/ui.tsx`); no one-off styles for the same control.
- **C4 Responsive layouts:** no horizontal scroll, overlap, or clipped CTA at
  **360, 390, 768, 1024, 1440 px**; touch targets **≥ 44×44 px** on wallet flows.
- **C5 Accessibility (WCAG 2.2 AA):** contrast **≥ 4.5:1** (text) / **≥ 3:1**
  (large text, UI components); full keyboard traversal with visible focus; every
  icon-only button has an accessible label; form errors are announced
  (`aria-describedby`/`role=alert` or equivalent) — not color-only.
- **C6 Loading states:** navigation paints a skeleton/loader within **300 ms**;
  async actions disable their trigger + show progress; no double-submit; stale
  data is never presented as fresh (revalidation or timestamp).
- **C7 Empty states:** every list (assets, activity, fiat ledger, apps, chains,
  contracts, fees, partners, sessions, connections) has an explicit empty state
  with a next-step CTA — never a blank panel.
- **C8 Error feedback (sad-path parity):** every failure (network, 401, OTP
  failure, insufficient funds, invalid address, quote expiry, rejected consent,
  save conflict) shows WHAT happened + WHAT to do next + recovery action
  (retry / go back / contact path); no raw codes, no silent failures, no
  stranded screens. 401 outside `/v1/auth/*` returns to login with context
  preserved (per `App.tsx` `onUnauthorized` contract).

## 5. Primary-workflow completion criteria (contract-first)

These are the workflow contracts. The audit PASSES a workflow only if its
happy path and its named sad paths both meet the AC. Format is
**Given-When-Then** per scenario.

### Users (wallet)

- **W-U1 Sign in (email OTP + passkey):** Given a new/existing user on
  `login`, when they complete OTP (and passkey/PID claim where required), then
  they land on `home` with session persisted; Given an expired/invalid OTP,
  then C8 error with retry; Given a 401 mid-session, then back to `login`
  without a dead screen.
- **W-U2 Home/balance/deposit:** Given an authed user on `home`, when the
  balance/deposit targets load, then amounts + deposit addresses are shown and
  copy works; Given zero assets, then C7 empty state with fund/receive CTA.
- **W-U3 Send payment:** Given a funded wallet on `send`, when the user enters
  recipient + amount and confirms the review step, then a success receipt
  appears AND a matching `activity`/`activity-detail` entry exists; Given an
  invalid address or insufficient funds, then inline C8 error blocks confirm.
- **W-U4 Receive:** Given a user on `receive`, when they view/share the
  address, then the shown address matches the account and copies exactly.
- **W-U5 Swap / top-up / fiat transfer:** Given a user starting a quote, when
  they confirm, then the quote breakdown (fees, total, expiry) was shown
  BEFORE confirm and the ledger entry (`fiat-detail`/`fiat-ledger-detail`)
  matches; Given quote expiry, then C8 error with re-quote action.
- **W-U6 Activity history:** Given history on `activity`, when the user opens
  any entry, then `activity-detail` shows correct amount, status, and
  counterpart; Given no history, then C7 empty state.
- **W-U7 Third-party approve (SSO / popup / embed):** Given a relying-party
  request (`?redirect_uri=`, `?popup=<action>`, `?embed=1`), when the user
  approves, then consent scope is shown BEFORE approval and the caller receives
  the code/result; Given reject, then the caller gets a clean cancel (no hang,
  no partial auth). Scope shown must equal scope granted — any mismatch is a
  critical finding.
- **W-U8 Settings management:** Given changes in profile/passkey/sessions/
  connected-accounts/app-connections, when saved/revoked, then the list
  reflects the change on revisit and revocation actually invalidates.

### Developers (dashboard)

- **W-D1 Create app + credentials:** Given `/` apps+gate, when a developer
  creates an app and configures redirect URIs + chains, then credentials are
  issued and shown exactly once with a rotation path.
- **W-D2 App settings edit:** Given `/apps/:id`, when settings are edited and
  saved, then a success confirmation appears and revisit shows persisted values;
  Given a save conflict/validation error, then C8 error names the field.
- **W-D3 Chains/contracts/fees/partners config:** Given each manager page, when
  an entry is created/edited, then the list reflects it and invalid input is
  blocked with a field-level message.
- **W-D4 Demo round-trip:** Given `/demo`, when the documented flow is run,
  then it completes end-to-end against the configured app without console-error
  noise or undocumented steps.

## 6. Edge cases to enumerate per workflow (not optional)

Empty, null, boundary, concurrent, offline, permission-denied: zero-balance
send; invalid/mismatched address; OTP expiry + resend storm; double-click
confirm (idempotency); session expiry mid-flow; popup blocked/closed early;
SSO `redirect_uri` mismatch; embed without bearer; offline submit then retry;
revoked session reuse; workspace with zero apps/chains. Each must map to C6/C7/C8.

## 7. NFRs (numbers — SMART)

1. Coverage: **100%** of S1–S7 visited at all five widths (360/390/768/1024/1440
   for wallet; 768+ for dashboard) with evidence links.
2. Every C1–C8 cell has a verdict; **0** findings without an AC citation.
3. Contrast ≥ 4.5:1 / 3:1, targets ≥ 44px, loader ≤ 300ms, **0** icon-only
   buttons without labels, **0** silent-failure paths.
4. Report: one checklist table + ranked findings (critical/major/minor) + route +
   screenshot/video + AC id + proposed fix owner (Backend/Frontend/DevOps/
   Security/QA). Cosmetic-only items filed separately as OUT — never mixed in.
5. No real secrets, tokens, or customer data in findings (reference by name).

## 8. Backward compatibility & dependency mapping

- Audit must NOT propose breaking changes to SSO/popup/embed protocols,
  redirect-URI validation, or API shapes. Any proposal that does is flagged
  `migration-required` with owner + rollout note — never silently recommended.
- Blocks: this scope (ANT-330) gates audit execution under ANT-219. Execution
  needs a seeded demo app + funded test wallet (owner: audit executor, via CTO
  if access is missing). Security-relevant findings (auth, PII, payments) go to
  SecurityEngineer for review before final; AC validation of fixes goes to QA.
  Disagreement on scope/priority escalates to CTO with options + recommendation.

## 9. MVP slicing

- Phase 0 (this ticket): scope + AC gate. Done = this doc posted + linked.
- Phase 1: user-side audit (S1–S5 + W-U1–U8).
- Phase 2: developer-side audit (S6–S7 + W-D1–D4).
- Phase 3: fix backlog (child issues per workstream, one per surface max).
  Phases 1–2 may parallelize with two executors; Phase 3 waits for triage.

## 10. Open questions (owner + default if unanswered)

1. Officially supported widths — is 360px floor correct, and is dashboard
   mobile (360–390) in or out? Owner: CTO. Default: wallet 360+ in, dashboard
   768+ in, narrower = best-effort notes only.
2. WCAG target — is 2.2 AA the bar, or AAA for auth/consent? Owner: CTO.
   Default: AA, with AAA contrast on consent screens.
3. Is `?embed=1` iframe flow in-audit or deferred? Owner: CTO. Default: IN for
   W-U7 (approve/reject legibility) only.
4. Seed data / test funds for audit execution — who provisions? Owner: CTO.
   Default: executor requests; blocked → reassign to unblocker per charter.

## 11. Acceptance criteria for THIS scope ticket (done = all true)

- [ ] This scope doc is posted on ANT-330 (document or comment) and linked.
- [ ] S1–S7 mapped to implementation paths above (verifiable in repo).
- [ ] C1–C8 + W-U1–U8 + W-D1–D4 defined as Given-When-Then-checkable items.
- [ ] Out-of-scope cosmetic list (§3) present with no-ACopic-reject rule.
- [ ] NFR numbers (§7), compat + dependency map (§8), questions + owners (§10).
- [ ] Freshness evidence pasted in PR/task comment; PR base = `paperclip`.
- [ ] CTO review requested with decision summary; on sign-off, ANT-330 → done.
