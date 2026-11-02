# Brand — PeridotID

PeridotID is the gaming identity wallet of the Peridot ecosystem. Its visual
language is the PeridotVault one: dark, technical and restrained, with peridot
green used for emphasis. This file is the source of truth for `apps/wallet` and
`apps/dashboard`; the marketing site
(`PeridotVault/App/website/peridotvault`) owns the original tokens.

## Color

Implemented values live in `apps/wallet/src/shared/styles/tokens.css` +
`theme.ts` (kept byte-identical) and `apps/dashboard/src/index.css`. Dark only.

| Token | Value | Use |
| --- | --- | --- |
| `--background` | `#0d0f0e` | Main canvas |
| `--surface`, `--card` | `#060807` | Secondary surfaces |
| `--foreground` | `#e0e4e4` | Primary text |
| `--paragraph` | `#b5b5b5` | Body copy |
| `--primary` | `#349b65` | Primary brand green |
| `--secondary` | `#349b6650` | Translucent green accents |
| `--accent` | `#87ee83` | Emphasis, hover, focus ring, success |
| `--border` | `#ffffff28` | Component borders |
| `--line` | `#ffffff14` | Decorative rails and dividers |
| `--label` | `#ffffff60` | Decorative details; check contrast before use as text |
| `--muted` / `--muted-foreground` | `#363636` / `#7d7d7d` | Muted surfaces and text |

Use semantic utilities (`bg-background`, `text-foreground`, `text-paragraph`,
`border-line`). Do not use `--line` for a control boundary or focus indicator.
Check text contrast against the real surface.

## Typography

- **Display and body:** Space Grotesk (Google Fonts `<link>` in each
  `index.html`).
- **Money and changing figures:** JetBrains Mono — saldo, nominal transaksi,
  alamat/ID. Never set balances in the display face.
- **Level chips:** Space Grotesk semibold — levels use the same face as the UI;
  there is no badge-only typeface.
- One `h1` per screen; keep heading hierarchy.

## Logo

- `apps/*/public/logo/logo-text.svg` — the horizontal lockup (peridot mark +
  PID wordmark). Used by the wallet header (`HomeHeader`), the loader/splash
  (`BrandMark`, `apps/wallet/index.html`) and the auth mastheads. White
  wordmark: only place it on the dark background.
- `apps/*/public/logo/logo.png` — the square mark; favicon and app icon only.
- The header shows no PID text: identity lives on the Profile screen.

## Surfaces and shape

Square corners (radius 0), flat surfaces, thin borders. Dark only — the
dashboard pins `class="dark"` on `<html>`; there is no light theme or toggle.

## Shell layout

One content column (576px) at every width; the chrome around it changes:

| Width | Shell |
| --- | --- |
| `<768` | rail: top bar (logo + profile) + content + bottom tabs |
| `768–1279` | sidebar 232 + rail (top bar stays inside the rail) |
| `>=1280` | nav 240 + rail 576 + info 300, 24px gaps, frame 1164 |

- Three-column: the brand sits at the top of the nav and the profile at the top
  of the info rail, so the content starts at the very top — never below a
  full-width bar, never an empty band in the middle.
- Nav is a `nav[aria-label="Primary"]` (icon + label, active = tint + inset
  accent bar); info is an `aside` with the company line, legal links and the
  network mode. Neither draws a border — `s.rail` stays the only line owner.
- The TESTNET badge must stay visible at every width (ANT-15): top bar below
  1280, info rail from 1280 up.

## Layout and lines (connected frame)

Lines must connect. Never place bordered cards side by side with a gap — the
borders stop and restart, which is exactly what this system avoids.

- **One rail owner.** `AppColumn` renders a single `s.rail` box (`border-x`,
  `--line`) around the top bar, content and tab bar (wide layout: around the
  content column). The column, the stack box and the overlay **never** draw
  their own border — nesting two of them doubles the line one pixel apart.
- **Containers own lines, content owns padding.** `Section` is
  `border-t border-line` with no padding; `SectionHead` (`px-6 py-5`) pads
  titles and text blocks; list rows carry `px-6 py-3` themselves. That is how
  a divider runs rail to rail instead of stopping 24px short.
- **Stacked blocks:** `border-t` with no margin and no gap; the first block on a
  screen uses `border-t-0`.
- **Cells:** a row of cells is one `CellGrid` (`grid gap-px bg-line`) with
  `Cell` children (`bg-background`) — the 1px gap is the shared divider. Never
  wrap a `CellGrid` in padded content; pad inside the cells.
- **Roles:** `--border` (`#ffffff28`) is for controls, inputs and dialogs;
  `--line` (`#ffffff14`) is for structure. `bg-surface` (`#060807`) belongs to
  sheets, modals and overlays — content cells sit on `bg-background`.
- **Alerts:** a warning or error is a tinted band (`bg-secondary`,
  `bg-danger/10`) with its own `border-t`, inside the flow — not a floating box.
- **Interactive rows:** keep a subtle hover (`hover:bg-surface`) plus the focus
  ring; the divider alone is not an affordance. State changes may not shift
  layout (use an inset shadow, not a thicker border).
- **Dashboard:** `Card` is a content cell (`border-t`, `p-6`). Cards stack with
  no margin; cards in a grid sit on `grid gap-px bg-line` and drop their own
  `border-t` so the gap supplies the single line.

Wallet primitives: `shared/components/ui/{Section,CellGrid}.tsx`.

## Deviation from the marketing site

- Root font size stays `1rem` in both apps. The marketing site's `0.85rem` is a
  layout decision for its rail system; the apps size in fixed px and would
  shift by 15% if it were copied.
- No `RailSection`/`RailEdges`/navbar system. Apps are a canvas plus cards; the
  rail vocabulary belongs to the marketing site.
- `--font-serif` is gone from both apps: display type is Space Grotesk, figures
  are JetBrains Mono.

## Applying the brand

- Prefer named tokens and shared components over new one-off colors.
- Visible focus (`--ring` = `#87ee83`), semantic controls, accessible labels.
- Check contrast on dark surfaces, mobile 375px, tablet 768px, desktop 1280px.
- Load `frontend-design-guidelines`, `design-taste` and `number-formatting`
  (project skills, `.agents/skills/`) before UI work; run
  `web-design-guidelines` for accessibility audits.
