# XP & Leveling runbook (ANT-445)

For the on-call stranger at 3am. Alert source:
`deploy/alerts/xp-leveling-check.sh` (cron every 5 min, exit 2 = ALERT).
Queries: `xp-leveling-detected.sql`. Thresholds are env-tunable starting
points (see script header) — tune, don't hardcode business caps.

## Triage order

1. **ledger-drift CRITICAL** — possible data corruption or bad migration.
   - Check: `sum(deltaXp)` vs `sum(totalXp)` from the alert line; per-pid
     sample lists affected PIDs.
   - Action: freeze XP-awarding intake (see Kill-switch below), then escalate
     to Backend (Tyler) + CTO. Do NOT edit ledger rows by hand — the ledger
     is append-only; repair is policy reactivation + re-level path only.
2. **quota-breach CRITICAL** — an app was awarded over its `dailyCap`.
   - Check: `admin → Leveling → XP History` filtered by app; confirm whether
     the cap was raised recently (audit log `admin.xp.quota.set`).
   - Action: suspend the app's quota (`suspendApp`, reason required), escalate
     to Backend + Security (Tobias). Cap-enforcement failure = release-gate
     item; XP-awarding stays frozen until root-caused.
3. **self-grant CRITICAL** — unreviewed `xp.self_grant` signal.
   - Check: `admin → Leveling → Suspicious` for the row (app + actor admin).
   - Action: review the grant (`reviewSuspicious` with note). If illegitimate,
     revoke `xpEnabled` for the app + escalate to Security. F3 control.
4. **award-spike / concentration** — farming, abuse, or viral growth.
   - Check: 1h per-app breakdown (top app named in alert); cross-check
     suspicious feed + 429 probe.
   - Action: if abusive, suspend the app quota; if organic, tune
     `XP_AWARD_SPIKE_15M` / `XP_CONCENTRATION_*` for the environment.
5. **suspicious / level-skew / throttle-spike** — investigate via dashboard
   (`Leveling → Overview / Suspicious`), tune thresholds if organic.

False-positive tuning: adjust the `XP_*` env vars on the cron line for that
stack and note the new values in the ANT-445 thread. Never edit thresholds
by changing app code.

## Kill-switch: stop awards without touching the ledger

**Who flips:** any `Role.admin` via dashboard (`Leveling → Tasks / Applications`)
or admin API. No deploy, no SSH, no DB writes.

**How (in order of breadth):**
1. Narrow: suspend the offending app — `PATCH admin/xp/apps/:appId/suspend`
   (`suspended=true`, `suspendReason` required, 400 without it). Stops that
   app's awards only.
2. Wide: deactivate the task — task status → `inactive`. Stops that task's
   awards across all apps.
3. Widest: revoke XP permission — `xpEnabled=false` per app, or suspend all
   XP-apps. Stops all intake awards.

**Expected effect:** new award attempts fail closed (permission error, no
ledger write). Existing `totalXp`/levels, ledger history, and reads
(`GET level`, dashboard) are unaffected — the ledger is never rewritten.

**How to confirm:** `XP History` shows no new `task_award` rows after the
flip; `Overview → Recent activity` is quiet; the check script's `awards_15m`
drops to 0 within one cron cycle (5 min).

**Rollback of the kill-switch** (re-enable): unsuspend / reactivate /
`xpEnabled=true` (grants to own app fire the `xp.self_grant` alert by design
— review it). Missed awards are NOT backfilled by hand; if a re-level is
needed it goes through the M3 migration tooling path (policy reactivation +
re-level, no ledger rewrite).

**Open item (M3):** end-to-end kill-switch proof (flip → intake attempt →
permission error + zero ledger rows) requires the M3 intake API (Tyler
ANT-441, no branch on origin yet as of 2026-10-22). This runbook's mechanism
(suspend/xpEnabled checks) is M2-merged; the intake-side enforcement (checks
inside the award txn per Tobias F2) lands with M3 and will be verified here
before any XP-awarding release (binding gate: no release without Tobias
sign-off + passing tests).
