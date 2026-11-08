#!/usr/bin/env bash
# Rebuilds the demo video. Pass --no-record to re-cut existing footage only.
set -euo pipefail
cd "$(dirname "$0")/../.."
.local/demo-video/venv/bin/python -I scripts/demo-video/narrate.py
if [[ "${1:-}" != "--no-record" ]]; then
  corepack pnpm exec tsx scripts/demo-video/record.ts
fi
python3 scripts/demo-video/assemble.py
