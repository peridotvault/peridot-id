# AGENTS.md — wallet (`apps/wallet`) foldering

First-party wallet app (Vite + React web SPA). Hand-rolled navigation in `App.tsx` (shell);
screens communicate via callback props (`onDone`, `goSend`, …), never imports.

## Layout

```
App.tsx               # shell/composer — wires screens + providers + TabBar
src/
  pages/<domain>/     # 23 pages in domain folders (auth|home|chain|fiat|
                      # activity|identity|embed) — flat, screen files only, no
                      # subfolders. Route-private helpers live in-file. Never
                      # screen→screen imports.
  shared/             # highest reusable layer: usable by >1 feature AND by shell
    styles/           # index.css (+tokens/fonts/base split), theme.ts
                      # (TS token source, byte-identical to tokens.css),
                      # stylesheet.ts (StyleSheet + flatten, Phase 4 exceptions)
    data/             # api-cache.ts (cachedRead/invalidate/clearApiCache),
                      # currency.ts (IDR/USD pref + CoinGecko), fiat.ts
                      # (FiatItem/FiatLedgerItem + labels + sumIdr),
                      # format.ts (fmtDate feed helper, used by 2 feats),
                      # network-mode.ts (testnet store; view: hooks/useNetworkMode)
    app/              # AppContext.tsx (SDK provider + usePeridot()),
                      # config.ts (API_BASE_URL), fiat-ensure.ts (post-auth
                      # provisioning check), shims.ts (Buffer bootstrap,
                      # first import in main.tsx), openExternal.ts
                      # (openExternalUrl, guards via safeUrl.ts), safeUrl.ts
    components/
      ui/             # generic primitives: Pressable, UIButton, TextField,
                      # Modal, BottomSheet, ScrollArea, BackButton,
                      # PushHeader, AsciiRidges(*)
      shell/          # app chrome: TabBar, TopBar, HomeHeader, AppColumn,
                      # LoadingScreen, AccountSwitcherModal
      icons.ts        # lucide barrel (deep per-icon imports only)
    hooks/            # session bootstrap/sync, startup gate, network-mode
                      # view, wide layout, window dimensions
  feat/<domain>/      # auth | chain | fiat | identity | embed — one domain
                      # capability each (one SDK namespace); each: components/
                      # hooks/ utils/ — no loose files
  modules.d.ts        # ambient type shims (stays at src/ root)
```

## Import rules

1. `pages/<domain>/` → may import from `shared/` and `feat/` only.
   **Never** from another screen (same folder or otherwise). No subfolders
   under `pages/` — route-private helpers live in the screen file.
2. `shared/` → may import from `shared/` only (any subfolder).
   **Never** from `pages/` or `feat/`. Shell-only app-wide modules
   (`app/config`, `app/fiat-ensure`, `components/shell/TabBar`) live
   here, never in a feat. `components/ui/` primitives never import
   from `components/shell/` (shell composes ui, not the reverse).
3. `feat/<domain>/` → may import from `shared/` and from its **own**
   folder only. **Never** from `pages/`, **never** from another feat.
   Needed by 2+ feats? Promote it to `shared/`.
4. `App.tsx` may import from `pages/`, `shared/`, and `feat/`.
   Nothing may import from `App.tsx`.
5. New code: route-private (1 screen, incl. multi-namespace assembly and
   pure nav/chrome) → in-file helpers in the screen (`pages/` is flat);
   single-domain → `feat/<domain>/` (private: never import another feat,
   `shared/` never imports `feat/`); used by 2+ domains → `shared/`.
   `shared/data|hooks|app` must be multi-domain or shell infra (the
   composition root: App + shell chrome). `shared/components/ui` is the
   design system — generic primitives, exempt from multi-use.
   Test: which SDK namespace does it wrap? More than one (or none) means
   it is not a feat. No new top-level `src/*.ts` files.

## Page → domain map (no `Page` suffix — the folder says it; `pages/activity`
composes `feat/chain` + `feat/fiat` — the merge is the page's job, there is
no `feat/activity`)

- `auth`: Login, Provisioning, Approve
- `home`: Home (dashboard aggregate; all route-private code in-file)
- `chain`: Send, Receive, Swap, Activation
- `fiat`: Topup, FiatTransfer, FiatDetail, FiatLedgerDetail, FiatAccount
- `activity`: Activity, ActivityDetail
- `identity`: Profile, EditProfile, ConnectedAccounts, Passkey,
  Sessions, AppConnections, Settings (profile+settings+security merged)
- `embed`: EmbedConnect (iframe entry, shell-routed — not in tab nav)

## Guards (CI, `rg`-style like the other repo guards)

```sh
W=apps/wallet
# shared must not reference pages/ or feat/, and must never escape src/shared/
rg "from\s+['\"][^'\"]*(pages|feat)/" $W/src/shared && exit 1
rg "from\s+['\"]\.\./\.\./\.\./" $W/src/shared && exit 1
# pages: flat (no subfolders) + shared/feat imports only (bare react/sdk
# packages untouched). Same-folder screen→screen imports have nowhere to
# hide: any RELATIVE import outside shared/|feat/ fails.
test -z "$(find $W/src/pages -mindepth 2 -type d)" || exit 1
rg -o "from\s+['\"]\.[^'\"]+['\"]" $W/src/pages | rg -v "shared/|feat/" && exit 1
# ui primitives never import shell chrome (shell composes ui, not the reverse)
rg "from\s+['\"][^'\"]*components/shell/" $W/src/shared/components/ui && exit 1
# no cross-feat imports: every RELATIVE import in feat/ must stay in-folder
# (./ same-dir or ../components|hooks|utils) or go to shared/. Catches the
# ../../<other-feat>/ shape the old feat/ substring check was blind to.
for f in auth chain fiat identity embed; do
  rg -o "from\s+['\"]\.[^'\"]+['\"]" $W/src/feat/$f \
    | rg -v "shared/" | rg -v "from\s+['\"]\./[^'\"/]+['\"]" \
    | rg -v "from\s+['\"]\.\./(components|hooks|utils)/" && exit 1
done
```

## Execute gate (unknown-target disclosure)

- Every `peridot.wallet.execute` call site must route through
  `assertExecuteGateAllows(action, payload, { unknownAcknowledged })`
  (`feat/auth/utils/knownPrograms.ts`) BEFORE any passkey ceremony.
  New direct `execute` calls without the gate are a spec violation.

## Done (Phase 1)

- `feat/chain/hooks/useActivationGate.ts` — single activation gate
  (was duplicated in Receive/Activation).
- `feat/chain/hooks/useCopyAddress.ts` — keyed clipboard (was duplicated).
- `shared/data/fiat.ts`: `fmtIdr`, `transferFeeOf`, `pickMethod`
  (were duplicated in Topup/Approve).
- `feat/fiat/components/FiatQuoteBreakdown.tsx` — single quote breakdown +
  method picker used by TopupScreen and ApproveScreen (screens may import
  any feat, so it lives in feat/fiat, not shared/).

## Done (Phase 2 — screens are slim composers)

- Home → `pages/home/Home.tsx` (route assembly: `useHomeData`, `calcTotal`,
  `TotalBalanceSection`, `QuickActions`, `SendChoiceModal` in-file — no
  single feat owns them) over `feat/chain/{utils/assets,components/AssetSection}`
  + `feat/fiat/components/FiatAccountActions` (tap DOKU card → Rupiah page).
- Activity → `pages/activity/Activity.tsx` composes `feat/chain/hooks/useChainHistory`
  + `feat/fiat/hooks/useFiatHistory` (merge + tab header inline — composition
  is the page's job) over `feat/chain/components/ChainRow` and
  `feat/fiat/components/{FiatRow,LedgerRow}`.
- Receive/Activation → `feat/chain/{utils/deposit-targets,
  hooks/useDepositTargets,components/DepositCardList,SolActivationModal,
  DepositAddressCard,ActivationStatusCard}` (reuses Phase-1 gate/copy hooks).
- Topup → `feat/fiat/{utils/topup-amount,hooks/useDepositQuote,
  hooks/useCheckoutSync}`.
- Approve → `feat/auth/{utils/popupAction,hooks/usePopupRequest,
  components/PopupReview}` + `feat/fiat/hooks/useFiatPrepare`.
- Login → `feat/auth/{hooks/useAppVerified,useLoginSession,usePidClaim,
  useSignInMethods,useConsentActions,utils/parseOAuthError,
  components/PidClaimForm,LoginOptions}` (+`finishSso` lives in `utils/sso.ts`).
- Deliberately duplicated (not unified): Home vs Activity `TabButton`
  variants, modal vs explainer activation copy.

## Done (Phase 4 — Tailwind styling)

- Tokens in `shared/styles/tokens.css` `@theme` (byte-identical to `styles/theme.ts`;
  `styles/theme.ts` stays the TS token source). Per-file `StyleSheet.create` is
  gone except documented exceptions.
- Rules: paint via `className`; `flexDirection` stays a style prop and
  `Pressable` (plain `<button>`) backgrounds/borders/padding go on an inner
  wrapper `div` (inline style beats any class). Never
  `bg-[rgba()]` (scanner skips it — use `bg-black/60`-style modifiers);
  icon color via `text-*`, never the `color` prop (dynamic tint values
  stay inline props); placeholders via `[--placeholder:var(--color-…)]`.
  Text sizes use scale tokens only (`text-xs`…`text-5xl`) — never `text-[]`.
- `shared/components/ui/BackButton.tsx` — single back affordance used by all
  detail screens. `UIButton` keeps its stylesheet (variant backgrounds
  live on the `Pressable` itself); `BottomSheet` keeps one scrim style
  for the same reason. `ScrollArea` inners keep plain objects (no class
  path) — so `theme.ts` keeps the shared `styles` block (`container`,
  `card`, `input`, …) while per-file blocks are gone.

## Done (Phase 5 — semantic DOM, no RN shim)

- `src/shared/primitives.tsx` is deleted. Elements are semantic HTML:
  `View`→`div` (+`flex flex-col`, shim default), `Text`→`span`/`p`/`h1`,
  `Pressable`/`TouchableOpacity`→`shared/components/ui/Pressable.tsx`
  (plain `<button>`), `TextInput`→`TextField.tsx`, `ScrollView`→`ScrollArea.tsx`
  (same props), `Image`→`img`, `Modal`→`components/ui/Modal.tsx`,
  `useWindowDimensions`→`shared/hooks/`, `Linking`→`shared/app/openExternal.ts`,
  `Alert`→`window.confirm`. Style helpers live on in `shared/styles/stylesheet.ts`.
- Exactly one `h1` per screen (screen title; `PushHeader` title is the `h1`
  on pushed screens). Guard: `rg "shared/primitives" apps/wallet/src apps/wallet/App.tsx` must print nothing.

## Done (Phase 3 — App.tsx is a pure composer)

- `shared/hooks/useSessionBootstrap.ts` — bootstrap, post-auth routing,
  account-switch reload (+`Screen` union, shared by shell and hooks).
- `shared/hooks/useSessionSync.ts` — cross-tab/refocus sync (subscribes
  once, conditions via refs).
- `shared/hooks/useStartupGate.ts` — fonts, 8s failsafe, splash handoff.
- App.tsx keeps: client instantiation, screen state, router JSX, `logout`,
  selection callbacks. The `Screen` type lives with the session hook;
  `loginContext` is typed `unknown` there (only truthiness matters —
  keeps the shared→feat guard green).

## Done (Phase 6 — foldering resync)

- `feat/embed/` is a sixth domain (guard loop covers it now): Screen lives
  in `pages/embed/EmbedConnect.tsx`, bridge in `feat/embed/hooks/useEmbedBridge.ts`,
  client in `utils/embed-client.ts` — no loose files at feat roots.
- `feat/auth/popup-login.ts` + `sso.ts` moved to `feat/auth/utils/`
  (were loose at the feat root); all importers updated.
- `shared/utils/` (empty, only `.gitkeep`) deleted. Rule 5 still holds:
  new shared code lands as a named top-level module, not a utils pile.

## Done (Phase 7 — grouped folders, deep modules)

- `src/index.css` → `shared/styles/` (`index` + `tokens` + `fonts` +
  `base` split); `theme.ts` + `styles.ts`→`stylesheet.ts` joined them.
  `main.tsx` re-pointed. Byte-identical token rule now spans
  `styles/tokens.css` ↔ `styles/theme.ts`.
- `shared/` grouped by role: `styles/` (paint), `data/` (reads:
  api-cache, currency, fiat, network-mode), `app/` (bootstrap:
  AppContext, config, fiat-ensure, shims, openExternal, safeUrl),
  `components/{ui,shell}` + `icons.ts`, `hooks/` (unchanged).
  `useNetworkMode` stays in `hooks/` (view over the `data/` store).
- `TopBar` + `HomeHeader` moved `feat/wallet/components/` →
  `components/shell/` (shell chrome, same as TabBar; sole caller is App).
- `screens/` → `pages/` in domain folders mirroring `feat/` (= map above);
  `*Screen` suffix stripped (`Home`, not `HomePage` — the folder says it).
  The `Screen` union type keeps its name (router vocabulary, not a file).
- `FiatSection` moved `feat/wallet/` → `feat/fiat/components/` (fiat rail was
  mis-homed); `SectionTitle` → `components/ui/` (2-domain generic).
  Verified the rest of the fiat smell in `feat/wallet/` is legitimate:
  dashboard aggregate (`useHomeData`), portfolio total (`assets`,
  `TotalBalanceSection`), send entry (`SendChoiceModal`).
  Guards rewritten for depth: screens allowlist (`shared/`|`feat/`
  only), shared no-escape (`../../`), ui-never-imports-shell.
- Depth check (codebase-design): moves only, no new interfaces —
  `data/` modules (`cachedRead`, `fmtIdr`, network store) were already
  deep; nothing introduced a hypothetical seam.

## Done (Phase 8 — feat = model)

- `feat/wallet/` split: on-chain model → `feat/chain/` (send, receive,
  deposit targets, activation gate, address utils, `history.ts` chain
  formatters + `useChainHistory`); dashboard aggregate → `feat/home/`
  (`useHomeData`, `assets`, `TotalBalanceSection`, `AssetSection`,
  `QuickActions`, `SendChoiceModal`). `pages/wallet/` split the same way
  (`pages/home/Home`, `pages/chain/Send|Receive|Swap|Activation`).
  Moves only — same depth, so `shared/`/`../utils/` imports unchanged.
- `feat/activity/` dissolved (a read-projection, not a model): `ChainRow`
  → `feat/chain/`; `FiatRow`/`LedgerRow` + fiat selectors →
  `feat/fiat/utils/history.ts`; `fmtDate` → `shared/data/format.ts`
  (rule 5: used by 2 feats); merge (`selectVisible`) + tab header inlined
  in `pages/activity/Activity.tsx`; `useActivityFeed` split into
  `useChainHistory` + `useFiatHistory` (each half verbatim, same resub).
  Supersedes the Phase 7 "fiat smell is legitimate" note above.
- Guard loop covers `auth chain home fiat identity embed` now.

## Done (Phase 9 — route-private code colocates, feat = one namespace)

- `feat/home/` was a route-named bucket (same sin as `feat/wallet/`),
  corrected same-session: its 6 files → `pages/home/{components,hooks,
  utils}/` (private to the Home route). `useHomeData` wraps 5 SDK
  namespaces — no single feat can own it; the portfolio sections and
  nav chrome wrap none. Assembly + chrome belong to the route.
- Rule 5 fixed (it manufactured fake feats): 1 screen →
  `pages/<route>/` submodules; single-domain, 2+ screens →
  `feat/<domain>/`; 2+ domains → `shared/`.
- Guards: pages allowlist now also bans `../../` in non-shared/feat
  relative imports (escaping the route folder); cross-feat loop covers
  `auth chain fiat identity embed`.

## Done (Phase 10 — pages are flat, feat owns its domain)

- `pages/home/` submodules deleted (the Phase 9 colocation violated the
  pages-are-pure-screens law): chain-pure `assets.ts` (`Coin`,
  `fmtBalance`, `shortMint`, `buildCoins`) → `feat/chain/utils/assets.ts`;
  `AssetSection` (already fully props-driven) → `feat/chain/components/`
  (zero import changes — same depth); `useHomeData`, `calcTotal`,
  `TotalBalanceSection`, `QuickActions`, `SendChoiceModal` inlined in
  `pages/home/Home.tsx` (~410 lines: honest size for a dashboard —
  assembly + chrome belong to the route).
- `calcTotal` unit test dropped (`tokens.test.mjs` keeps `buildCoins`/
  `shortMint` from `feat/chain`): testing it would mean importing from a
  page — a layering violation. Covered by typecheck.
- `shared/` audited file-by-file: everything live, no deletions.
  `HomeHeader` is used by `TopBar`, `useWideLayout` by `TabBar`/`AppColumn`,
  `useWindowDimensions` by `useWideLayout` — a premature delete was caught
  and restored before verification. Single-use generics (`Modal`,
  `BottomSheet`, `BackButton`) stay: `shared/components/ui` is the design
  system, exempt from multi-use (moving a generic Modal into a feat would
  be wrong-homing). `shared/data|hooks|app` = multi-domain or shell infra.
- Guards fixed: pages = flatness (`find -mindepth 2`) + strict allowlist
  (no submodules left to allow); cross-feat check rewritten — the old
  `feat/` substring match was blind to `../../<other-feat>/` imports
  (green in practice, broken in theory; verified both directions).
