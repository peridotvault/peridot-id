#!/usr/bin/env bash
# Faucet prod lock — runtime preflight (ANT-290, board order 2026-10-21:
# the sandbox faucet is strictly sandbox-only, NEVER on main).
#
# Sourced by deploy/up.sh (no side effects on source — defines one function).
# The caller must provide: compose() (up.sh wrapper with Infisical/env-file
# resolution) and PROJECT (compose project name).
#
# The backend registers POST /v1/fiat/test-credit iff PID_FAUCET_ENABLED is
# exactly 'true'; a 'true' value reaching a MAIN deploy would let anyone mint
# spendable ledger credit on production. This preflight renders the effective
# main config through the SAME resolution the deploy itself uses and aborts
# unless the flag renders exactly "false" (empty = compose default false).
# Fail-closed: if the render itself fails, the main deploy aborts — a main
# deploy that cannot prove the faucet off does not ship.
faucet_preflight_main() {
  local rendered_config faucet_rendered
  if ! rendered_config="$(COMPOSE_PROJECT_NAME="$PROJECT" compose config 2>/dev/null)"; then
    echo "error: refusing main deploy — could not render compose config to verify PID_FAUCET_ENABLED (faucet prod lock)" >&2
    return 1
  fi
  faucet_rendered="$(printf '%s' "$rendered_config" | sed -n 's/^[[:space:]]*PID_FAUCET_ENABLED:[[:space:]]*//p' | tr -d '"' | head -n1)"
  if [ -z "${faucet_rendered:-}" ]; then
    faucet_rendered="false"  # key absent ⇒ compose default (:-false) applies
  fi
  if [ "$faucet_rendered" != "false" ]; then
    echo "error: refusing main deploy with PID_FAUCET_ENABLED='$faucet_rendered' (faucet is sandbox-only — see deploy/README.md)" >&2
    return 1
  fi
  echo "preflight: PID_FAUCET_ENABLED='$faucet_rendered' on main — faucet off, proceeding"
}
