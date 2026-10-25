# AGENTS.md — wallet (`apps/wallet`) foldering

First-party wallet app (Vite + React web SPA). Hand-rolled navigation in `App.tsx` (shell);
screens communicate via callback props (`onDone`, `goSend`, …), never imports.

## Layout

```
App.tsx               # shell/composer — wires screens + providers + TabBar
src/
  screens/            # 23 screens, FLAT (no subfolders, no screen→screen imports)
  shared/             # highest reusable layer: usable by >1 feature AND by shell
    theme.ts          # brand theme (colors/fonts/shared styles)
    AppContext.tsx    # SDK client provider + usePeridot()
    icons.ts          # lucide barrel (deep per-icon imports only)
    currency.ts       # IDR/USD pref (localStorage) + CoinGecko rates
    config.ts         # API_BASE_URL
    api-cache.ts      # cachedRead/invalidate/clearApiCache (screens + feats)
    network-mode.ts   # testnet store (view: hooks/useNetworkMode.ts)
    openExternal.ts   # openExternalUrl (guards via safeUrl.ts)
    safeUrl.ts        # assertSafeExternalUrl (shared→shared only)
    styles.ts         # StyleSheet + flatten helpers (Phase 4 exceptions)
    fiat-ensure.ts    # post-auth provisioning check (shell routing)
    fiat.ts           # FiatItem/FiatLedgerItem + status labels + sumIdr
    shims.ts          # Buffer/global bootstrap — imported first by main.tsx,
                      # runs before any Solana module (top-level Buffer use)
    components/       # UIButton, AsciiRidges(*), AccountSwitcherModal,
                      # LoadingScreen, TabBar, AppColumn, BackButton,
                      # BottomSheet, Modal, Pressable, PushHeader,
                      # ScrollArea, TextField
    hooks/            # session bootstrap/sync, startup gate, network-mode
                      # view, wide layout, window dimensions
  feat/<domain>/      # auth | wallet | fiat | activity | identity | embed
                      # (each: components/ hooks/ utils/ — no loose files)
  modules.d.ts        # ambient type shims (stays at src/ root)
```

## Import rules

1. `screens/` → may import from `shared/` and `feat/` only.
   **Never** from another screen.
2. `shared/` → may import from `shared/` only.
   **Never** from `screens/` or `feat/`. Shell-only app-wide modules
   (`config`, `fiat-ensure`, `TabBar`) live here, never in a feat.
3. `feat/<domain>/` → may import from `shared/` and from its **own**
   folder only. **Never** from `screens/`, **never** from another feat.
   Needed by 2+ feats? Promote it to `shared/`.
4. `App.tsx` may import from `screens/`, `shared/`, and `feat/`.
   Nothing may import from `App.tsx`.
5. New code: used by 1 domain → `feat/<domain>/` (`components/`,
   `hooks/`, `utils/` inside as needed); used by 2+ → `shared/`.
   No new top-level `src/*.ts` files.

## Screen → domain map (logical; screens stay flat in `screens/`)

- `auth`: Login, Provisioning, Approve
- `wallet`: Home, Send, Receive, Swap, Activation, FiatAccount
- `fiat`: Topup, FiatTransfer, FiatDetail, FiatLedgerDetail
- `activity`: Activity, ActivityDetail
- `identity`: Profile, EditProfile, ConnectedAccounts, Passkey,
  Sessions, AppConnections, Settings (profile+settings+security merged)
- `embed`: EmbedConnect (iframe entry, shell-routed — not in tab nav)

## Guards (CI, `rg`-style like the other repo guards)

```sh
W=apps/wallet
# shared must not reference screens/ or feat/
rg "from\s+['\"][^'\"]*(screens|feat)/" $W/src/shared && exit 1
# screens must not import sibling screens
rg "from\s+['\"]\./" $W/src/screens && exit 1
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
- `shared/fiat.ts`: `fmtIdr`, `transferFeeOf`, `pickMethod`
  (were duplicated in Topup/Approve).
- `feat/fiat/components/FiatQuoteBreakdown.tsx` — single quote breakdown +
  method picker used by TopupScreen and ApproveScreen (screens may import
  any feat, so it lives in feat/fiat, not shared/).

## Done (Phase 2 — screens are slim composers)

- Home → `feat/wallet/{utils/assets,hooks/useHomeData,components/HomeHeader,
  TotalBalanceSection,SectionTitle,FiatSection,QuickActions,AssetSection}`
  + `screens/FiatAccountScreen` + `feat/fiat/components/FiatAccountActions`
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

- Tokens in `src/index.css` `@theme` (byte-identical to `theme.ts`;
  `theme.ts` stays the TS token source). Per-file `StyleSheet.create` is
  gone except documented exceptions.
- Rules: paint via `className`; `flexDirection` stays a style prop and
  `Pressable` (plain `<button>`) backgrounds/borders/padding go on an inner
  wrapper `div` (inline style beats any class). Never
  `bg-[rgba()]` (scanner skips it — use `bg-black/60`-style modifiers);
  icon color via `text-*`, never the `color` prop (dynamic tint values
  stay inline props); placeholders via `[--placeholder:var(--color-…)]`.
  Text sizes use scale tokens only (`text-xs`…`text-5xl`) — never `text-[]`.
- `shared/components/BackButton.tsx` — single back affordance used by all
  detail screens. `UIButton` keeps its stylesheet (variant backgrounds
  live on the `Pressable` itself); `BottomSheet` keeps one scrim style
  for the same reason. `ScrollArea` inners keep plain objects (no class
  path) — so `theme.ts` keeps the shared `styles` block (`container`,
  `card`, `input`, …) while per-file blocks are gone.

## Done (Phase 5 — semantic DOM, no RN shim)

- `src/shared/primitives.tsx` is deleted. Elements are semantic HTML:
  `View`→`div` (+`flex flex-col`, shim default), `Text`→`span`/`p`/`h1`,
  `Pressable`/`TouchableOpacity`→`shared/components/Pressable.tsx`
  (plain `<button>`), `TextInput`→`TextField.tsx`, `ScrollView`→`ScrollArea.tsx`
  (same props), `Image`→`img`, `Modal`→`components/Modal.tsx`,
  `useWindowDimensions`→`shared/hooks/`, `Linking`→`shared/openExternal.ts`,
  `Alert`→`window.confirm`. Style helpers live on in `shared/styles.ts`.
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
  in `screens/EmbedConnectScreen.tsx`, bridge in `hooks/useEmbedBridge.ts`,
  client in `utils/embed-client.ts` — no loose files at feat roots.
- `feat/auth/popup-login.ts` + `sso.ts` moved to `feat/auth/utils/`
  (were loose at the feat root); all importers updated.
- `shared/utils/` (empty, only `.gitkeep`) deleted. Rule 5 still holds:
  new shared code lands as a named top-level module, not a utils pile.
