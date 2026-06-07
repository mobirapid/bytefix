#!/usr/bin/env bash
# ReGear launcher — one command to (re)start the app on the latest code.
#   Usage:  ./start.sh            run in the foreground (Ctrl+C to stop)
#           ./start.sh --bg       run in the background (logs to server.log)
#
# Does the three steps automatically:
#   1. install deps (fast no-op once installed)
#   2. free port 3000 if something is already on it
#   3. start the server  ->  http://localhost:3000  (admin at /admin)

set -e

# Always run from the project root (the folder this script lives in),
# so it works no matter where you call it from.
cd "$(dirname "$0")"

PORT="${PORT:-3000}"

echo "==> Installing dependencies (express)…"
npm install --no-audit --no-fund

echo "==> Freeing port $PORT (ignore any 'usage' message)…"
lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true

if [ "$1" = "--bg" ]; then
  echo "==> Starting ReGear in the background… (logs -> server.log)"
  nohup npm start > server.log 2>&1 &
  sleep 3
  echo "==> Started. Open http://localhost:$PORT  (admin at /admin)"
  echo "    Tail logs with:  tail -f server.log"
  echo "    Stop with:       lsof -ti:$PORT | xargs kill -9"
else
  echo "==> Starting ReGear… open http://localhost:$PORT  (admin at /admin)"
  echo "    (running in the foreground — press Ctrl+C to stop)"
  npm start
fi
