#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

mutagen project terminate
mutagen project list
