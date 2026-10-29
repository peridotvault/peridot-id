#!/usr/bin/env bash
# Isolated localnet ledger for one validator-suite run (ANT-870 P6.3).
#
# Footgun this fixes: treasury `init_treasury` is first-writer-wins per
# program id (ConfigAlreadyInitialized on re-init). Rerunning two suites
# against ONE ledger therefore fails the second suite at treasury init — not
# because the code regressed, but because the ledger still holds the first
# suite's config PDA. The fix is ledger isolation: one fresh ledger per suite.
#
# Usage:
#   ./fresh-ledger.sh [ledger-dir] [rpc-port]   # starts validator in background
#
# RPC ports of parallel instances must differ by 2+ (the validator also
# binds rpc+1 for pubsub), e.g. 8899 + 8931 — never adjacent ports.
#   PID_RPC_URL=http://127.0.0.1:8900 node tests/integration.mjs <program-id>
#   kill "$(cat <ledger-dir>.pid)"
#
# Defaults: ledger-dir = mktemp -d, rpc-port = 8899 (override with
# PID_RPC_PORT). Prints `PID_RPC_URL=...` for copy-paste / eval.
set -euo pipefail

LEDGER="${1:-$(mktemp -d /tmp/peridot-ledger-XXXXXX)}"
PORT="${2:-${PID_RPC_PORT:-8899}}"
mkdir -p "$LEDGER"

# Gossip/faucet/dynamic ports derive from the RPC port in non-overlapping
# strides of 64 so parallel isolated validators (e.g. a concurrent
# heartbeat's suite) never collide on the defaults (gossip :8000, faucet
# :9900) — or with each other (a naive +10000 scheme lets instance A's
# dynamic range grab instance B's gossip port).
STRIDE="$(( (PORT - 8900) * 64 ))"
GOSSIP_PORT="$((20000 + STRIDE))"
DYN_LO="$((20001 + STRIDE))"
DYN_HI="$((20020 + STRIDE))"
FAUCET_PORT="$((21000 + STRIDE))"

export PATH="$HOME/.local/share/solana/install/releases/2.3.13/solana-release/bin:$PATH"

# NOTE: pid/log live NEXT TO the ledger dir, never inside it:
# `solana-test-validator --reset` wipes the ledger dir on startup, which
# otherwise races (and deletes) a pidfile written milliseconds earlier —
# the exact flake this helper exists to prevent.
PIDFILE="$LEDGER.pid"
LOGFILE="$LEDGER.log"

nohup solana-test-validator \
  --ledger "$LEDGER" \
  --rpc-port "$PORT" \
  --faucet-port "$FAUCET_PORT" \
  --gossip-port "$GOSSIP_PORT" \
  --dynamic-port-range "$DYN_LO-$DYN_HI" \
  --reset >"$LOGFILE" 2>&1 &
VALIDATOR_PID="$!"
echo "$VALIDATOR_PID" >"$PIDFILE"
if [ ! -s "$PIDFILE" ]; then
  echo "failed to record validator pid" >&2
  exit 1
fi

# Wait for RPC readiness (bounded; override with LEDGER_WAIT_SECS — genesis
# creation is CPU-heavy and slow on loaded boxes).
WAIT_SECS="${LEDGER_WAIT_SECS:-60}"
for _ in $(seq 1 "$WAIT_SECS"); do
  if solana cluster-version --url "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
    echo "PID_RPC_URL=http://127.0.0.1:$PORT"
    echo "ledger: $LEDGER (pid $(cat "$PIDFILE"); log $LOGFILE)" >&2
    exit 0
  fi
  sleep 1
done
echo "validator on :$PORT did not come up; see $LOGFILE" >&2
kill "$(cat "$PIDFILE")" 2>/dev/null || true
exit 1
