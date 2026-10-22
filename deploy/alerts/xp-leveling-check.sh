#!/usr/bin/env bash
# ANT-445: cron-friendly check for XP & leveling alert thresholds (Tobias F5/F7).
# READ-ONLY against the DB (SELECT only, via xp-leveling-detected.sql).
#
# Signals: xp_ledger_entries (awards), xp_suspicious_activities (feed),
# xp_quotas (caps), user_xp_states (distribution), security_events (throttle
# probe — forward-compatible, reads 0 rows until M3 intake emits; OK by
# construction until then).
#
# Usage:
#   DATABASE_URL=postgresql://... ./xp-leveling-check.sh
#   DATABASE_URL=postgresql://... ALERT_ENV=production ./xp-leveling-check.sh
#   DATABASE_URL=postgresql://... ALERT_WEBHOOK_URL=https://... ./xp-leveling-check.sh
#
# Env overrides (thresholds are starting points per Tobias F5/F7 — tune per
# environment here, never hardcode business caps into app code):
#   ALERT_ENV=production|sandbox          (default: sandbox)
#   XP_AWARD_SPIKE_15M                    (default: 500)
#   XP_CONCENTRATION_MIN                  (default: 50  — min 1h awards before share matters)
#   XP_CONCENTRATION_PCT                  (default: 80  — top-app share %)
#   XP_SUSPICIOUS_MAX_1H                  (default: 20)
#   XP_LEVEL_MIN_USERS                    (default: 100 — min users before skew matters)
#   XP_LEVEL_SKEW_PCT                     (default: 95  — single-level share %)
#   XP_THROTTLE_MAX_15M                   (default: 50)
#
# Exit codes (Nagios/cron convention):
#   0 = OK (no threshold breached)
#   2 = ALERT (any Q breached)
#   3 = usage/config error (DATABASE_URL unset, psql missing/failing, bad output)
#
# Cron (every 5 min; installed by deploy/alerts/install.sh):
#   */5 * * * *  ALERT_ENV=production /opt/peridot-id/deploy/alerts/run-with-infisical.sh main xp-leveling-check.sh
#
# Rollback: remove the cron line (`crontab -l | grep -v 'xp-leveling' | crontab -`).
# No app, schema, or data changes are made by this check — nothing to undo.
#
# Runbook: deploy/alerts/xp-leveling-runbook.md (every alert links it).
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "CRITICAL: DATABASE_URL is not set (refusing to guess a target)" >&2
  exit 3
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "CRITICAL: psql not found in PATH" >&2
  exit 3
fi

ALERT_ENV="${ALERT_ENV:-sandbox}"
SPIKE="${XP_AWARD_SPIKE_15M:-500}"
CONC_MIN="${XP_CONCENTRATION_MIN:-50}"
CONC_PCT="${XP_CONCENTRATION_PCT:-80}"
SUSP_MAX="${XP_SUSPICIOUS_MAX_1H:-20}"
LVL_MIN="${XP_LEVEL_MIN_USERS:-100}"
SKEW_PCT="${XP_LEVEL_SKEW_PCT:-95}"
THR_MAX="${XP_THROTTLE_MAX_15M:-50}"

PSQL=(psql "$DATABASE_URL" -X -q -t -A)

Q1="SELECT count(*) FROM xp_ledger_entries WHERE kind = 'task_award' AND \"createdAt\" > now() - interval '15 minutes';"
Q2="SELECT coalesce(\"appId\",'(none)') AS app, count(*) AS n FROM xp_ledger_entries WHERE kind = 'task_award' AND \"createdAt\" > now() - interval '1 hour' GROUP BY 1 ORDER BY 2 DESC;"
Q3="SELECT count(*) FROM xp_suspicious_activities WHERE reviewed = false AND \"createdAt\" > now() - interval '1 hour';"
Q3B="SELECT id FROM xp_suspicious_activities WHERE reviewed = false AND signal = 'xp.self_grant' AND \"createdAt\" > now() - interval '24 hours' ORDER BY \"createdAt\" DESC LIMIT 20;"
Q4="SELECT a.\"appId\" || ' ' || count(*) || '/' || max(q.\"dailyCap\") FROM xp_ledger_entries a JOIN xp_quotas q ON q.\"appId\" = a.\"appId\" WHERE a.kind = 'task_award' AND a.\"createdAt\" > now() - interval '24 hours' AND q.\"dailyCap\" IS NOT NULL GROUP BY a.\"appId\" HAVING count(*) > max(q.\"dailyCap\");"
Q5A="SELECT coalesce(sum(\"deltaXp\"), 0) FROM xp_ledger_entries;"
Q5B="SELECT coalesce(sum(\"totalXp\"), 0) FROM user_xp_states;"
Q5C="SELECT s.pid FROM (SELECT pid, \"totalXp\" FROM user_xp_states ORDER BY \"updatedAt\" DESC LIMIT 200) s LEFT JOIN (SELECT pid, sum(\"deltaXp\") AS lt FROM xp_ledger_entries WHERE pid IN (SELECT pid FROM user_xp_states ORDER BY \"updatedAt\" DESC LIMIT 200) GROUP BY pid) l ON l.pid = s.pid WHERE coalesce(l.lt, 0) <> s.\"totalXp\" LIMIT 20;"
Q6="SELECT level AS lvl, count(*) AS n FROM user_xp_states GROUP BY 1 ORDER BY 1;"
Q7="SELECT count(*) FROM security_events WHERE \"eventType\" IN ('xp.throttled','xp.rate_limited','throttle.exceeded') AND \"createdAt\" > now() - interval '15 minutes';"

run_q() {
  local out
  if ! out="$("${PSQL[@]}" -c "$1" 2>&1)"; then
    echo "CRITICAL: query failed: $out" >&2
    exit 3
  fi
  printf '%s' "$out"
}

AWARDS_15M="$(run_q "$Q1" | tr -d '[:space:]')"
CONC_ROWS="$(run_q "$Q2")"
SUSP_1H="$(run_q "$Q3" | tr -d '[:space:]')"
SELFGRANT_ROWS="$(run_q "$Q3B")"
QUOTA_ROWS="$(run_q "$Q4")"
LEDGER_SUM="$(run_q "$Q5A" | tr -d '[:space:]')"
STATE_SUM="$(run_q "$Q5B" | tr -d '[:space:]')"
DRIFT_ROWS="$(run_q "$Q5C")"
LEVEL_ROWS="$(run_q "$Q6")"
THR_15M="$(run_q "$Q7" | tr -d '[:space:]')"

ALERT=0
NOTES=()

num_ok() { [[ "$1" =~ ^-?[0-9]+$ ]]; }

if ! num_ok "$AWARDS_15M" || ! num_ok "$SUSP_1H" || ! num_ok "$THR_15M"; then
  echo "CRITICAL: unexpected scalar output (awards=$AWARDS_15M suspicious=$SUSP_1H throttle=$THR_15M)" >&2
  exit 3
fi

if (( AWARDS_15M > SPIKE )); then
  NOTES+=("award-spike awards_15m=$AWARDS_15M > $SPIKE")
  ALERT=1
fi

# Concentration: top-app share of 1h awards.
CONC_TOTAL=0
CONC_TOP=0
CONC_TOP_APP=""
while IFS='|' read -r app cnt _rest; do
  [[ -z "${app//[[:space:]]/}${cnt//[[:space:]]/}" ]] && continue
  app="$(echo "$app" | tr -d '[:space:]')"; cnt="$(echo "$cnt" | tr -d '[:space:]')"
  [[ "$cnt" =~ ^[0-9]+$ ]] || { echo "CRITICAL: unexpected Q2 output: $app|$cnt" >&2; exit 3; }
  (( CONC_TOTAL += cnt ))
  if (( cnt > CONC_TOP )); then CONC_TOP=$cnt; CONC_TOP_APP="$app"; fi
done <<< "$CONC_ROWS"
if (( CONC_TOTAL >= CONC_MIN )) && (( CONC_TOP * 100 > CONC_PCT * CONC_TOTAL )); then
  NOTES+=("concentration top_app=$CONC_TOP_APP share=$(( CONC_TOP * 100 / CONC_TOTAL ))% of $CONC_TOTAL (1h)")
  ALERT=1
fi

if (( SUSP_1H > SUSP_MAX )); then
  NOTES+=("suspicious unreviewed_1h=$SUSP_1H > $SUSP_MAX")
  ALERT=1
fi

if [[ -n "${SELFGRANT_ROWS//[[:space:]]/}" ]]; then
  SG_N="$(echo "$SELFGRANT_ROWS" | grep -c . || true)"
  NOTES+=("self-grant CRITICAL unreviewed_xp.self_grant_24h=$SG_N (F3 tripwire)")
  ALERT=1
fi

if [[ -n "${QUOTA_ROWS//[[:space:]]/}" ]]; then
  NOTES+=("quota-breach CRITICAL over-dailyCap_24h: $(echo "$QUOTA_ROWS" | tr '\n' ';')")
  ALERT=1
fi

if [[ "$LEDGER_SUM" != "$STATE_SUM" ]]; then
  NOTES+=("ledger-drift CRITICAL sum(ledger)=$LEDGER_SUM != sum(state)=$STATE_SUM")
  ALERT=1
fi
if [[ -n "${DRIFT_ROWS//[[:space:]]/}" ]]; then
  DRIFT_N="$(echo "$DRIFT_ROWS" | grep -c . || true)"
  NOTES+=("ledger-drift CRITICAL per-pid mismatches (sample200): $DRIFT_N e.g. $(echo "$DRIFT_ROWS" | head -3 | tr '\n' ',' )")
  ALERT=1
fi

# Level skew: single-level share.
LVL_TOTAL=0
LVL_TOP=0
LVL_TOP_LVL=""
while IFS='|' read -r lvl cnt _rest; do
  [[ -z "${lvl//[[:space:]]/}${cnt//[[:space:]]/}" ]] && continue
  lvl="$(echo "$lvl" | tr -d '[:space:]')"; cnt="$(echo "$cnt" | tr -d '[:space:]')"
  [[ "$cnt" =~ ^[0-9]+$ ]] || { echo "CRITICAL: unexpected Q6 output: $lvl|$cnt" >&2; exit 3; }
  (( LVL_TOTAL += cnt ))
  if (( cnt > LVL_TOP )); then LVL_TOP=$cnt; LVL_TOP_LVL="$lvl"; fi
done <<< "$LEVEL_ROWS"
if (( LVL_TOTAL >= LVL_MIN )) && (( LVL_TOP * 100 > SKEW_PCT * LVL_TOTAL )); then
  NOTES+=("level-skew L$LVL_TOP_LVL holds $(( LVL_TOP * 100 / LVL_TOTAL ))% of $LVL_TOTAL users")
  ALERT=1
fi

if (( THR_15M > THR_MAX )); then
  NOTES+=("throttle-spike throttles_15m=$THR_15M > $THR_MAX (F5 429-spike)")
  ALERT=1
fi

if (( ALERT == 1 )); then
  MSG="ALERT [$ALERT_ENV] xp-leveling: $(IFS='; '; echo "${NOTES[*]}") — runbook: deploy/alerts/xp-leveling-runbook.md"
else
  MSG="OK: xp-leveling within thresholds [$ALERT_ENV] (awards_15m=$AWARDS_15M suspicious_1h=$SUSP_1H throttles_15m=$THR_15M drift=none)"
fi

echo "$MSG"
if (( ALERT == 1 )) && [[ -n "${ALERT_WEBHOOK_URL:-}" ]]; then
  curl -fsS -m 10 -X POST "$ALERT_WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    --data "$(printf '{"text": %s}' "$(printf '%s' "$MSG" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" \
    >/dev/null || echo "WARNING: webhook POST failed (alert still reported via stdout/exit code)" >&2
fi

(( ALERT == 1 )) && exit 2
exit 0
