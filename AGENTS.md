# AGENTS.md — PeridotID conventions

Project: **PeridotID** (repo `peridot-id`, short **`pid`**). Gaming identity wallet —
non-custodial Solana smart account with a **secp256r1 passkey** authority.

## Naming conventions (keep consistent)

- **Brand:** `PeridotID` in product copy; `peridot_id` for the Postgres DB name; `pid`
  for long identifiers (cookies `pid_access`/`pid_refresh`, env
  `PID_*`). "Peridot ecosystem" refers to the wider Peridot products — a different thing.
- **NPM packages:** `@peridotvault/pid-*` (npm org: `@peridotvault`; company: PT ANTIGANE LABS INDONESIA).
  **Published (7):** `pid-types`, `pid-core`, `pid-payments`, `pid-solana`, `pid-evm`,
  `pid-sdk-js`, `pid-react-embed`. **Never published:** `pid-api` and `pid-wallet`
  (the `apps/*` workspaces — `private: true`), `pid-openapi` (spec bundle,
  private), `pid-stellar` (testnet-only helpers, `private: true`), `pid-ui`
  (source-only UI shared by wallet + dashboard, `private: true`).
  Release: bump the version(s), then push tag `v<sdk-js version>` —
  `.github/workflows/publish.yml` publishes every bumped package with provenance.
  (`apps/docs` is the Mintlify docs source, not an npm package.)
- **On-chain:** PDA seed `["peridot_id", "account", sha256(pid)]`; signed-payload domain
  `PID|SOLANA|SMART_ACCOUNT|v1`; program id `CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT`.
- **Identity:** PID = `<handle>@pid` (e.g. `ifal@pid`) — permanent Antigane-ecosystem
  identity, user-chosen once at onboarding; immutable, never reused or reassigned.
  1 identity = 1 personal wallet (no account hub). Identity credentials
  key on `(provider, providerUserId)`. `pid` (not `peridot`) is
  the ecosystem namespace in identifiers (cookies `pid_access`/`pid_refresh`, env
  `PID_*`, codes `pid_code`/`pidapp_`/`pidsk_`).

## Branch flow (this repo)

Everything flows **branch → `dev` → `test` → `main`**. No pull requests: merge
locally, push `dev`, fast-forward `test` from `dev`, then promote `test` to
`main` (`git push origin test:main`). Feature branches are short-lived and land
in `dev` — never open a PR unless the owner asks for one.

## Environment

- **Secrets (Infisical Cloud, project `peridot-id-uf-w9`):** envs `dev` / `test` /
  `main`; folders `/apps/api` (runtime),
  `/apps/wallet` (`VITE_*`). No `/deploy` folder — it duplicated these.
  (Docs take zero secrets — there is no `/apps/docs` Infisical path.)
  Local: `infisical login` once, then `pnpm dev:api:cloud` (or
  `dev:wallet:cloud`). Deploy: `./deploy/up.sh main|test` sources the VPS machine
  identity at `/etc/peridot-id/infisical.env` (0600 root) and pulls via
  `infisical run`; no `deploy/.env.*` on the VPS. Fallback:
  `INFISICAL_ENABLED=0` reads `deploy/.env.$ENV`.
- **Network modes (mainnet | testnet):** ONE frontend origin pair — wallet
  `peridot.id`, dashboard `dashboard.peridot.id` — served by the main stack;
  the testnet stack is API + DB only (`--profile web` is main-only) and runs on
  its own VPS — the stacks share no DB or disk, only the origin pair and the
  `.peridot.id` cookie domain. The mode
  switch (admin sidebar) stores `pid_network_mode` and reloads, because the API origin is fixed
  per page load. Identity (PID, passkey, session) exists only in the mainnet
  DB; the testnet API proxies identity routes to mainnet and verifies sessions
  by introspection. One env per stack: `PID_NETWORK=mainnet|testnet`. Full
  model, reset policy, and consequences: `docs/NETWORK_MODES.md`.
- **Postgres DB:** `peridot_id` at `localhost:5432` (NOT `peridot`). `DATABASE_URL` in
  Infisical `/apps/api` (env `dev`), legacy fallback `apps/api/.env`.
- **Solana toolchain:** 2.3.13 at
  `~/.local/share/solana/install/releases/2.3.13/solana-release/bin` (platform-tools v1.48,
  rustc 1.84). The `active_release` symlink may point at a newer agave — use the 2.3.13
  path explicitly for `cargo build-sbf`.
- **Pinocchio** pinned to **0.10.2** (+ `solana-address =2.1.0`) because newer needs
  rustc 1.89. MSRV constraint is a hard build requirement.
- `packages/solana` is the only package allowed to import `@solana/web3.js` (web3.js layering rule).

## Run book (local)

```sh
export PATH="$HOME/.local/share/solana/install/releases/2.3.13/solana-release/bin:$PATH"
cd contracts/svm # chain state lives here (test-ledger/), never at root
solana-test-validator --reset > /tmp/validator.log 2>&1 &
solana config set --url http://127.0.0.1:8899 && solana airdrop 5
cd smart-account
PID_TREASURY=<treasury-pubkey> cargo build-sbf # canonical vault baked in (build.rs); no BACKEND since ANT-612
solana program deploy target/deploy/peridot_smart_account.so \
  --program-id target/deploy/peridot_smart_account-keypair.json
pnpm --filter @peridotvault/pid-api dev        # API on :3300
cd apps/wallet && pnpm dev:web         # Vite dev server on :3302
```

Login popup close check (the flow dapps depend on): open the dashboard demo
route (`/demo`) against the local wallet. Sign in once, then click “Sign in with
PeridotID” again with the wallet session already live — the popup must close by
itself (<2s), the demo must show the pid, and the popup must never land on the
dapp URL. Repeat after `localStorage.clear()` for the fresh-login path.

After pulling (or whenever Prisma complains about a missing column, e.g.
P2022 on `fiat_provider_*`): `pnpm --filter @peridotvault/pid-api exec
prisma migrate deploy`, then restart the API. (`nest --watch` rebuilds code
but never touches the DB schema; deploy applies migrations automatically.)

Env to set in `apps/api/.env`: `GOOGLE_CLIENT_ID`/`_SECRET` (dev Google
client with localhost redirect; same key names in every env, values differ —
prod values live in deploy env), `PID_PROGRAM_ID=G8tPC...`,
`CLIENT_SUCCESS_URL=http://localhost:3302`,
`CORS_ORIGINS=http://localhost:3302`. Restart the API after `.env` changes (`nest --watch` does not reload env).

Fiat (one namespace `fiat`, see docs/FIAT_LEDGER.md): **DOKU Checkout is
money-in only** (no Sub-Account). Every user balance lives on the internal
fiat ledger (`fiat_ledger_entries`). Env: `DOKU_MODE/CLIENT_ID/SECRET_KEY`
(Checkout), optional `PID_FIAT_LEDGER_ENABLED` (default true),
`PID_FIAT_LEDGER_APP_ALLOWLIST` (optional extra transfer allowlist),
`PID_FIAT_LEDGER_TREASURY_PID`, `DOKU_WEBHOOK_URL`. Recipients are eligible
when they own an active app in the DB (created in the dashboard) — no ops
registration. Fiat minimum/maximum are code constants in
`apps/api/src/fiat/fiat-limits.ts`, not env. On corroborated payment the
API issues `fiat_issue` (NET) + `fiat_fee`; issuance runs only inside the API
(CI-guarded — no route/SDK/wallet issuance). DOKU Sub-Account / Unified Ledger
code stays frozen (docs/archive/FUTURE_UNIFIED_LEDGER.md).

Local fiat loop: DOKU webhooks cannot reach `localhost`, so deposits rely on
explicit status checks, not pushes. TopupScreen auto-checks once per intent
and offers “Check payment status” (`syncTransaction` → `POST /v1/fiat/deposits/:id/sync`
— same corroborated path as the webhook, and it is what issues the ledger
credit). For real-time webhook delivery in dev, expose the API via a tunnel
(e.g. `ngrok http 3300`) and set `DOKU_WEBHOOK_URL` (+ `DOKU_CHECKOUT_NOTIFY_URL`)
to the tunnel URL — localhost values never reach DOKU.

## Login split (first-party wallet vs public flow)

- Wallet (`apps/wallet`) uses `sdk-js` direct calls with an explicit inline
  passkey signer + `pid-core`/`pid-solana` primitives only — never the popup /
  hosted flow (`popupBaseUrl`, `openLoginPopup`, `HOSTED_LOGIN_URL`,
  `PROD_BASE_URL`, `window.open`; CI guard in `ci.yml` fails the build otherwise).
- Dev and prod run the identical OAuth code path with identical key names; only
  values differ per env.
  Never point local dev at the prod callback and never add localhost URIs to the
  prod Google client — create a dev client instead.
- Only `pid-core` (primitives) and `pid-solana` (chain adapter) may import
  `@solana/web3.js` (web3.js layering rule, CI-enforced).

## UI / frontend

- `brand.md` is the source of truth for wallet + dashboard color, type and logo.
  Dark only; peridot green `#349b65` / `#87ee83`; Space Grotesk everywhere,
  JetBrains Mono for money and changing figures.
- Project skills in `.agents/skills/` (install with `npx skills add … -y`):
  load `frontend-design-guidelines` + `design-taste` for UI work,
  `number-formatting` for amounts, `page-load-animations` for entrance motion,
  `web-design-guidelines` for accessibility audits.
- Arctis `frontend` / `backend` / `monorepo` are vendored there too, so every
  clone has them (no user-scope plugin needed). `.claude/skills/*` are symlinks
  into `.agents/skills/*` — add a skill once, link it once.
- Both apps ship shadcn-style primitives in the brand skin. Wallet:
  `Button` (cva variant table) + `Dialog`/`Modal`/`BottomSheet` in
  `shared/components/ui`. Dashboard: `src/shared/ui/` (button, input,
  textarea, select, label, field, table, card, badge, segmented, switch);
  screens keep importing from `workspace/ui.tsx` (`Card`, `Badge`,
  `Segmented`/`SegmentedItem`, `MiniButton`, `FIELD` = the same input string,
  `SECTION_LABEL`/`METRIC`/`MUTED`/`ERROR`/`WARN`).
  Behavior comes from ui-sdk (`Dialog`, `Tabs`, `Switch`), not Radix.
  Rules that keep the audit from drifting back: every content group is a
  `Card` (never a bare bordered div), every table comes from `table.tsx`
  (its head/row hairline is built in), tabs use `Segmented`, pills/chips use
  `Badge`, links are quiet (`hover:text-foreground`) except inside prose,
  hover tints are `bg-muted/40`, and the cut-corner button is gone.
  `cn()` lives in `apps/wallet/src/shared/styles/cn.ts` and
  `apps/dashboard/src/lib/cn.ts`.
- Tokens follow shadcn's semantic contract (`--primary`, `--secondary`,
  `--card-foreground`, `--popover*`, `--destructive`, `--input`, `--chart-*`,
  `--sidebar*`) with brand values — dark only. Radius: both apps run the same
  peridotbase scale (wallet `--radius-sm|md|lg|xl` = 6/8/10/14, dashboard
  `--radius: 0.625rem`), so controls, rows and panels are rounded in both.
  The peridot-only keys (`--surface`, `--paragraph`,
  `--line`, `--label`, `--brand-1/2`) stay. **No `rounded-full`** anywhere
  (avatars, icon tiles, switches, badges, progress bars, status dots): use the
  radius scale. The only exception is token/chain logos (`AssetSection`,
  `ChainRow`, dashboard token + chain logos), which stay circular.
- `packages/react-embed` deliberately stays style-free (published, renders
  inside a host page): no Tailwind, no ui-sdk, no shadcn.
- `packages/ui` (`@peridotvault/pid-ui`) is the private, source-only shared UI:
  `Popover` owns the anchored popover chrome (body portal, scrim, fixed
  position from the anchor, grow-in/shrink-out in `popover.css`, Escape) and is
  used by both the wallet profile menu and the dashboard pid menu. Each app
  imports `@peridotvault/pid-ui/popover.css` and lists the source in `@source`
  (the package lives outside the app's Tailwind scan root). Any new shared
  component lands there, not copied into a second app.

## ui-sdk

- `@ui-sdk/react` + `@ui-sdk/core` are installed in `apps/wallet` and
  `apps/dashboard`; default styles come from `@ui-sdk/core/web.css`, imported
  once in each app's global stylesheet (`layer(components)` above Tailwind's
  base, below its utilities).
- Before using ui-sdk, follow the `ui-sdk` skill if it is installed (it is, in
  `.agents/skills/ui-sdk`), and read
  `apps/<app>/node_modules/@ui-sdk/react/docs/llms.txt` (pnpm does not hoist to
  the repo root). To build a new component, also search
  `.../docs/core.md` by heading, and read `.../docs/rendering.md` next to it.

## Verification

- API: `pnpm --filter @peridotvault/pid-api exec jest` (318 tests).
- EVM: `forge test --root contracts/evm` (95: V4 owner/permission/adversarial + V3 hard-close pins);
  anvil loops `test/anvil-v4-e2e.mjs` + `test/anvil-v4-perm-e2e.mjs` + `test/anvil-v4-batch-e2e.mjs`.
- Program: `PID_TREASURY=<key> cargo test` (76, incl. ANT-612 no-allowlist + ANT-863 B2 hard-close pins) +
  `tests/integration.mjs` (~67 cases: V4 + V3 hard-close pins) +
  `tests/session.mjs <program-id> <forwarder-id>` (24 session cases; deploy
  `contracts/svm/mock-forwarder` first) against the local
  validator; devnet E2E `packages/sdk-js/test/devnet.e2e.mjs`.
- Full: `pnpm typecheck`.

## Notes

- The Secp256r1 precompile enforces low-S and does not simulate correctly — send with
  `skipPreflight`; expiries use the chain clock (`Clock` sysvar), not the device clock.
- `sol_sha256` syscall crashes this SBF toolchain — the program uses pure-Rust SHA-256
  (`src/sha256.rs`).