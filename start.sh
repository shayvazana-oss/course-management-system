#!/usr/bin/env bash
# Serve PDF Form Studio locally. Nothing leaves your machine.
# Usage: bash start.sh   then open the printed URL in your browser.
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-8080}"
echo ""
echo "  PDF Form Studio  —  עורך טפסי PDF מקומי"
echo "  --------------------------------------------------------"
echo "  Open:  http://localhost:${PORT}/"
echo "  All processing is local. Press Ctrl+C to stop."
echo ""
if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "${PORT}"
elif command -v python >/dev/null 2>&1; then
  exec python -m http.server "${PORT}"
elif command -v npx >/dev/null 2>&1; then
  exec npx --yes http-server -p "${PORT}" -c-1 .
else
  echo "Need python3 (or node/npx) to serve. Please install one." >&2
  exit 1
fi
