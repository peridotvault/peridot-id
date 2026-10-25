# AGENTS.md — wallet (`apps/wallet`) foldering

First-party wallet app (Vite + React web SPA). Hand-rolled navigation in `App.tsx` (shell);
screens communicate via callback props (`onDone`, `goSend`, …), never imports.

## Layout

```
App.tsx               # shell/composer — wires screens + providers + TabBar
src/
  pages/<domain>/     # 23 pages in domain folders (auth|wallet|fiat|
                      # activity|identity|embed) — never screen→screen imports
  shared/             # highest reusable layer: usable by >1 feature AND by shell
    styles/           # index.css (+tokens/fonts/base split), theme.ts
                      # (TS token source, byte-identical to tokens.css),
                      # stylesheet.ts (StyleSheet + flatten, Phase 4 exceptions)
    data/             # api-cache.ts (cachedRead/invalidate/clearApiCache),
                      # currency.ts (IDR/USD pref + CoinGecko), fiat.ts
                      # (FiatItem/FiatLedgerItem + labels + sumIdr),
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
  feat/<domain>/      # auth | wallet | fiat | activity | identity | embed
                      # (each: components/ hooks/ utils/ — no loose files)
  modules.d.ts        # ambient type shims (stays at src/ root)
```

## Import rules

1. `pages/<domain>/` → may import from `shared/` and `feat/` only.
   **Never** from another screen (same folder or otherwise).
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
5. New code: used by 1 domain → `feat/<domain>/` (`components/`,
   `hooks/`, `utils/` inside as needed); used by 2+ → `shared/`.
   No new top-level `src/*.ts` files.

## Page → domain map (= `pages/` folders, mirrors `feat/`; no `Page` suffix — the folder says it)

- `auth`: Login, Provisioning, Approve
- `wallet`: Home, Send, Receive, Swap, Activation
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
# pages: every RELATIVE import must be shared/ or feat/ (blocks same-folder
# AND cross-folder page imports; bare react/sdk packages are untouched)
rg -o "from\s+['\"]\.[^'\"]+['\"]" $W/src/pages | rg -v "shared/|feat/" && exit 1
# ui primitives never import shell chrome (shell composes ui, not the reverse)
rg "from\s+['\"][^'\"]*components/shell/" $W/src/shared/components/ui && exit 1
# no cross-feat imports (one line per feat)
for f in auth wallet fiat activity identity embed; do
  rg "from\s+['\"][^'\"]*feat/" $W/src/feat/$f \
    | rg -v "feat/$f/" && exit 1
done
```

## Execute gate (unknown-target disclosure)

- Every `peridot.wallet.execute` call site must route through
  `assertExecuteGateAllows(action, payload, { unknownAcknowledged })`
  (`feat/auth/utils/knownPrograms.ts`) BEFORE any passkey ceremony.
  New direct `execute` calls without the gate are a spec violation.

## Done (Phase 1)

- `feat/wallet/hooks/useActivationGate.ts` — single activation gate
  (was duplicated in Receive/Activation).
- `feat/wallet/hooks/useCopyAddress.ts` — keyed clipboard (was duplicated).
- `shared/data/fiat.ts`: `fmtIdr`, `transferFeeOf`, `pickMethod`
  (were duplicated in Topup/Approve).
- `feat/fiat/components/FiatQuoteBreakdown.tsx` — single quote breakdown +
  method picker used by TopupScreen and ApproveScreen (screens may import
  any feat, so it lives in feat/fiat, not shared/).

## Done (Phase 2 — screens are slim composers)

- Home → `feat/wallet/{utils/assets,hooks/useHomeData,components/HomeHeader,
  TotalBalanceSection,SectionTitle,FiatSection,QuickActions,AssetSection}`
  + `pages/fiat/FiatAccount` + `feat/fiat/components/FiatAccountActions`
  (tap DOKU card → Rupiah page).
- Activity → `feat/activity/{utils/feed,hooks/useActivityFeed,
  components/ActivityHeader,ChainRow,FiatRow,LedgerRow}`.
- Receive/Activation → `feat/wallet/{utils/deposit-targets,
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
