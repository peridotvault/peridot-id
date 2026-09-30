# AGENTS.md — wallet (`apps/wallet`) foldering

First-party wallet app (Expo). Hand-rolled navigation in `App.tsx` (shell);
screens communicate via callback props (`onDone`, `goSend`, …), never imports.

## Layout

```
App.tsx               # shell/composer — wires screens + providers + TabBar
src/
  screens/            # 21 screens, FLAT (no subfolders, no screen→screen imports)
  shared/             # highest reusable layer: usable by >1 feature AND by shell
    theme.ts          # brand theme (colors/fonts/shared styles)
    AppContext.tsx    # SDK client provider + usePeridot()
    icons.ts          # lucide barrel (deep per-icon imports only)
    currency.ts       # IDR/USD pref (localStorage) + CoinGecko rates
    config.ts         # API_BASE_URL
    fiat-ensure.ts    # post-auth provisioning check (shell routing)
    fiat.ts           # FiatItem/FiatLedgerItem + status labels + sumIdr
    components/       # UIButton, AsciiRidges(*), AccountSwitcherModal,
                      # LoadingScreen, TabBar
    hooks/  utils/    # future shared extractions land here
  feat/<domain>/      # auth | wallet | fiat | activity | identity
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
- `wallet`: Home, Send, Receive, Swap, Activation
- `fiat`: Topup, FiatTransfer, FiatDetail, FiatLedgerDetail
- `activity`: Activity, ActivityDetail
- `identity`: Profile, EditProfile, ConnectedAccounts, Passkey,
  Sessions, AppConnections, Settings (profile+settings+security merged)

## Guards (CI, `rg`-style like the other repo guards)

```sh
W=apps/wallet
# shared must not reference screens/ or feat/
rg "from\s+['\"][^'\"]*(screens|feat)/" $W/src/shared && exit 1
# screens must not import sibling screens
rg "from\s+['\"]\./" $W/src/screens && exit 1
# no cross-feat imports (one line per feat)
for f in auth wallet fiat activity identity; do
  rg "from\s+['\"][^'\"]*feat/" $W/src/feat/$f \
    | rg -v "feat/$f/" && exit 1
done
```

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
  BalanceCard,QuickActions,AssetSection}`.
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
  components/PidClaimForm,LoginOptions}` (+`finishSso` lives in `sso.ts`).
- Deliberately duplicated (not unified): Home vs Activity `TabButton`
  variants, modal vs explainer activation copy, `BackButton` (2 uses —
  extract on 3rd).

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
