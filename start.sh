#!/bin/zsh
# Start Stavya Radiology on :4000 using Node 24+ (required for node:sqlite).
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

NODE=""
for c in /opt/homebrew/opt/node@24/bin/node /opt/homebrew/bin/node "$(command -v node)"; do
  if [[ -x "$c" ]]; then
    major="$("$c" -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
    if [[ "$major" -ge 22 ]]; then NODE="$c"; break; fi
  fi
done

if [[ -z "$NODE" ]]; then
  echo "Need Node.js >= 22.5 (for node:sqlite)."
  echo "Install: brew install node@24"
  echo "Your current node: $(command -v node) -> $(node -v 2>/dev/null || echo missing)"
  exit 1
fi

echo "Using $NODE ($("$NODE" -v))"

# Free :4000 if something else holds it
if lsof -iTCP:4000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port 4000 busy — stopping previous listener…"
  kill $(lsof -t -iTCP:4000 -sTCP:LISTEN) 2>/dev/null || true
  sleep 0.5
fi

export PORT=4000 HOST=0.0.0.0
export RIS_DEMO_PASSWORD="${RIS_DEMO_PASSWORD:-1234}"
export RIS_DEMO_WEAK_PASSWORDS="${RIS_DEMO_WEAK_PASSWORDS:-1}"
export RIS_DEV_OTP="${RIS_DEV_OTP:-1}"

echo "Starting Stavya RIS at http://0.0.0.0:4000 (LAN shareable) …"
exec "$NODE" server/index.js
