#!/usr/bin/env bash
# ANT-215: fail-closed guard binding PID_PROGRAM_ID to the cluster deploy keypair.
#
# Why this exists (Tobias ANT-212 Finding 3 on ANT-211): a typo'd PID_PROGRAM_ID
# that still base58-decodes to 32 bytes builds green and bricks at runtime
# (`IncorrectProgramId`). Length-only validation in build.rs cannot catch that —
# only equality against the deploy keypair's pubkey can. Same for an unset env
# silently falling back to the local/devnet default on a testnet build.
#
# Deploy-job usage (run BEFORE cargo build-sbf, with the SAME env):
#   PID_PROGRAM_ID=<id> ./contracts/svm/assert-program-id.sh \
#       --keypair <cluster-keypair.json> --require-explicit
#   PID_PROGRAM_ID=<id> cargo build-sbf   # same PID_PROGRAM_ID value
#
# CI usage (hermetic, no solana toolchain — see .github/workflows/ci.yml
# job `svm-program-id`): --expected instead of --keypair.
#
# Exit 0 = safe to build. Anything else = do not build; the message says why.
# Never prints keypair secret bytes — only pubkeys (public values).
set -euo pipefail

REQUIRE_EXPLICIT=0
PROGRAM_ID="${PID_PROGRAM_ID:-}"
EXPECTED=""
KEYPAIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --require-explicit) REQUIRE_EXPLICIT=1; shift ;;
    --program-id) PROGRAM_ID="${2:-}"; shift 2 ;;
    --expected) EXPECTED="${2:-}"; shift 2 ;;
    --keypair) KEYPAIR="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '1,20p' "$0"; exit 0 ;;
    *)
      echo "error: unknown flag: $1 (see --help)" >&2; exit 2 ;;
  esac
done

if [ -z "$PROGRAM_ID" ]; then
  if [ "$REQUIRE_EXPLICIT" = "1" ]; then
    echo "error: PID_PROGRAM_ID is unset and --require-explicit was given." >&2
    echo "Refusing the silent local/devnet default: set PID_PROGRAM_ID to the" >&2
    echo "cluster deploy keypair's pubkey before building for testnet/mainnet." >&2
    exit 1
  fi
  echo "warn: PID_PROGRAM_ID unset — build will use the local/devnet default."
  echo "Pass --require-explicit in testnet/mainnet deploy jobs to forbid this."
  exit 0
fi

# Validate charset + 32-byte decode (python3, stdlib only — no solana toolchain).
if ! python3 - "$PROGRAM_ID" <<'EOF'; then
import sys
s = sys.argv[1].strip()
alphabet = set("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
if not s or any(c not in alphabet for c in s):
    print(f"error: PID_PROGRAM_ID is not base58: {s!r}", file=sys.stderr)
    sys.exit(1)
num = 0
for c in s:
    num = num * 58 + "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".index(c)
raw = num.to_bytes((num.bit_length() + 7) // 8 or 1, "big")
leading = len(s) - len(s.lstrip("1"))
out = b"\x00" * leading + raw
if len(out) != 32:
    print(f"error: PID_PROGRAM_ID must decode to 32 bytes, got {len(out)}", file=sys.stderr)
    sys.exit(1)
EOF
  exit 1
fi
PROGRAM_ID="$(printf '%s' "$PROGRAM_ID" | tr -d '[:space:]')"

# Resolve the expected pubkey: deploy keypair wins when both are given.
if [ -n "$KEYPAIR" ]; then
  if [ ! -f "$KEYPAIR" ]; then
    echo "error: keypair file not found: $KEYPAIR" >&2
    exit 1
  fi
  if command -v solana-keygen >/dev/null 2>&1; then
    EXPECTED="$(solana-keygen pubkey "$KEYPAIR")"
  else
    # Fallback: keypair JSON is 64 secret bytes; pubkey = last 32, base58-encoded.
    EXPECTED="$(python3 - "$KEYPAIR" <<'EOF'
import json, sys
raw = bytes(json.load(open(sys.argv[1])))
assert len(raw) == 64, "keypair file must hold 64 bytes"
pub = raw[32:]
alpha = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
num = int.from_bytes(pub, "big")
enc = ""
while num > 0:
    num, r = divmod(num, 58)
    enc = alpha[r] + enc
pad = len(pub) - len(pub.lstrip(b"\x00"))
print("1" * pad + (enc or "1"))
EOF
)"
  fi
  echo "deploy keypair pubkey: $EXPECTED"
fi

if [ -z "$EXPECTED" ]; then
  # No keypair/expected to compare against: charset+length already passed.
  # NOTE: this cannot catch a typo that still decodes to 32 bytes (Finding 3) —
  # the deploy job must pass --keypair so equality is checked below.
  echo "ok: PID_PROGRAM_ID decodes to 32 bytes, no keypair to compare (length-only check)."
  echo "Deploy jobs: pass --keypair <cluster-keypair.json> for the equality check."
  exit 0
fi

if [ "$PROGRAM_ID" != "$EXPECTED" ]; then
  echo "error: PID_PROGRAM_ID mismatch — build would brick at runtime (IncorrectProgramId)." >&2
  echo "  PID_PROGRAM_ID: $PROGRAM_ID" >&2
  echo "  expected:       $EXPECTED" >&2
  echo "Fix: export PID_PROGRAM_ID=<expected> (same value) and rebuild." >&2
  exit 1
fi

echo "ok: PID_PROGRAM_ID equals deploy keypair pubkey ($EXPECTED)."
