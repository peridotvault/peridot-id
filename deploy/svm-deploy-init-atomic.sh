#!/usr/bin/env bash
# ANT-806: atomic SVM program deploy + treasury init in ONE operator execution.
#
# What changes: none on-chain (program code untouched). This wraps the existing
#   `solana program deploy|upgrade` + `init_treasury` (disc 15) into a single
#   fail-closed run with the SAME operator keypair as initer == initial admin,
#   then verifies config PDA admins[0] == operator before declaring success.
#   Closes the deploy->init frontrunner window (first-writer-wins tiebreak).
#
# Blast radius: writes ONLY the program account + config/treasury PDAs on the
#   target cluster. No API, no backend, no user PDAs, no shared-stack deploys.
# Rollback path: treasury init is first-writer-wins and IRREVERSIBLE on that
#   program id. If init is not yours (exit 3/4), redeploy under a FRESH program
#   keypair and re-run this script. Never reuse a raced program id in prod.
# Verify: script exits 0 only after on-chain config verify; CI runs
#   `node --check` on the companion .mjs (see .github/workflows/ci.yml).
# Who is affected: the human operator running the prod deploy; no live stack
#   moves until the board orders mainnet execution (never run this against
#   mainnet without a board order on the ticket).
#
# Runbook hygiene: every ALERT line names the recovery. 3am rule: any non-zero
#   exit means "do NOT proceed to mainnet cutover" — page per RELAYER_RUNBOOK.
#
# Usage:
#   ./deploy/svm-deploy-init-atomic.sh \
#     --program-keypair <program-keypair.json> \
#     --operator-keypair <operator-keypair.json> \
#     --rpc-url <cluster-rpc> \
#     --so-path <peridot_smart_account.so> \
#     [--upgrade] [--program-id <base58>]
#
#   Default mode is a FRESH deploy. Pass --upgrade for an existing program.
#   --program-id defaults to the program keypair's pubkey (fail-closed: the
#   same equality the ANT-215 assert-program-id.sh guard enforces).
#   Secrets are never printed — only pubkeys and signatures enter logs.
set -euo pipefail

PROGRAM_KEYPAIR=""
OPERATOR_KEYPAIR=""
RPC_URL=""
SO_PATH=""
UPGRADE=0
PROGRAM_ID=""

while [ $# -gt 0 ]; do
  case "$1" in
    --program-keypair) PROGRAM_KEYPAIR="${2:-}"; shift 2 ;;
    --operator-keypair) OPERATOR_KEYPAIR="${2:-}"; shift 2 ;;
    --rpc-url) RPC_URL="${2:-}"; shift 2 ;;
    --so-path) SO_PATH="${2:-}"; shift 2 ;;
    --upgrade) UPGRADE=1; shift ;;
    --program-id) PROGRAM_ID="${2:-}"; shift 2 ;;
    -h|--help) sed -n '1,30p' "$0"; exit 0 ;;
    *) echo "error: unknown flag: $1 (see --help)" >&2; exit 2 ;;
  esac
done

[ -n "$PROGRAM_KEYPAIR" ] || { echo "error: missing --program-keypair" >&2; exit 2; }
[ -n "$OPERATOR_KEYPAIR" ] || { echo "error: missing --operator-keypair" >&2; exit 2; }
[ -n "$RPC_URL" ] || { echo "error: missing --rpc-url" >&2; exit 2; }
[ -n "$SO_PATH" ] || { echo "error: missing --so-path" >&2; exit 2; }
[ -f "$PROGRAM_KEYPAIR" ] || { echo "error: program keypair not found: $PROGRAM_KEYPAIR" >&2; exit 2; }
[ -f "$OPERATOR_KEYPAIR" ] || { echo "error: operator keypair not found: $OPERATOR_KEYPAIR" >&2; exit 2; }
[ -f "$SO_PATH" ] || { echo "error: program .so not found: $SO_PATH" >&2; exit 2; }
command -v solana >/dev/null 2>&1 || { echo "error: solana CLI not on PATH (pinned 2.3.13, see contracts/svm/README.md)" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "error: node not on PATH (needed for the init step)" >&2; exit 2; }

# Resolve expected program id from the program keypair (fail-closed default).
if [ -z "$PROGRAM_ID" ]; then
  if command -v solana-keygen >/dev/null 2>&1; then
    PROGRAM_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
  else
    echo "error: --program-id omitted and solana-keygen unavailable to derive it" >&2
    exit 2
  fi
fi
echo "program id:      $PROGRAM_ID"
echo "operator keypair: $OPERATOR_KEYPAIR (pubkey printed by init step)"
echo "rpc:             $RPC_URL"

# Step 0 — ANT-215 guard: PID_PROGRAM_ID must equal the deploy keypair pubkey.
# Same value must be baked at build time (PID_PROGRAM_ID=<id> cargo build-sbf).
if [ -n "${PID_PROGRAM_ID:-}" ] && [ "$PID_PROGRAM_ID" != "$PROGRAM_ID" ]; then
  echo "error: PID_PROGRAM_ID ($PID_PROGRAM_ID) != program keypair pubkey ($PROGRAM_ID)." >&2
  echo "Rebuild with PID_PROGRAM_ID=$PROGRAM_ID or pass the matching --program-keypair." >&2
  exit 2
fi

# Step 1 — deploy (fresh) or upgrade (existing), signed by the operator keypair.
# The operator keypair becomes upgrade authority on fresh deploys.
if [ "$UPGRADE" = "1" ]; then
  echo "--- step 1/2: solana program upgrade (authority = operator) ---"
  # NOTE: `solana program upgrade` takes a WRITTEN BUFFER + program id
  # positionally (no --program-id flag, CLI 2.3.13). The buffer keypair is
  # ephemeral: generated here, deleted right after the upgrade lands.
  BUFFER_KEYPAIR="$(mktemp -u /tmp/program-buffer-XXXXXX.json)"
  solana-keygen new --no-bip39-passphrase --silent --outfile "$BUFFER_KEYPAIR" >/dev/null
  BUFFER_ADDR="$(solana-keygen pubkey "$BUFFER_KEYPAIR")"
  solana program write-buffer "$SO_PATH" \
    --buffer "$BUFFER_KEYPAIR" \
    --keypair "$OPERATOR_KEYPAIR" \
    --url "$RPC_URL"
  solana program upgrade "$BUFFER_ADDR" "$PROGRAM_ID" \
    --keypair "$OPERATOR_KEYPAIR" \
    --url "$RPC_URL"
  rm -f "$BUFFER_KEYPAIR"
else
  echo "--- step 1/2: solana program deploy (authority = operator) ---"
  solana program deploy "$SO_PATH" \
    --program-id "$PROGRAM_KEYPAIR" \
    --keypair "$OPERATOR_KEYPAIR" \
    --url "$RPC_URL"
fi

# Step 2 — init_treasury BACK-TO-BACK in this same operator execution:
# initer == initial_admin == operator (ANT-801 H3), then on-chain verify.
echo "--- step 2/2: atomic init_treasury + config verify ---"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/svm-init-treasury-atomic.mjs" "$PROGRAM_ID" \
  --operator-keypair "$OPERATOR_KEYPAIR" \
  --rpc-url "$RPC_URL"
INIT_RC=$?
if [ "$INIT_RC" -ne 0 ]; then
  echo "ALERT deploy landed but treasury init is NOT yours (init step exit $INIT_RC)." >&2
  echo "ALERT Do NOT declare success. Recovery: redeploy under a FRESH program keypair." >&2
  exit "$INIT_RC"
fi

echo "OK atomic deploy+init complete: program $PROGRAM_ID, treasury admins[0] == operator."
