#!/usr/bin/env bash
# Puts this computer back to "Hmail never ran here", for a from-scratch demo.
# It archives instead of deleting: a house key owns its ENS name forever, so old
# keys are kept under ~/.hmail-archive. It never touches ~/.hmail-p1, other HORS
# profiles (demo, hors-luma, ...), or .env.local.
set -euo pipefail

PORT="${HMAIL_PORT:-8390}"
STATE="${HMAIL_STATE_DIR:-$HOME/.hmail}"
HORS="${HORS_HOME:-$HOME/.hors}"
PREFIX="${DEMO_PREFIX:-lyjdemo}"
WEB="${HMAIL_WEB_ORIGIN:-https://hmail-web.vercel.app}"
ARCHIVE="$HOME/.hmail-archive/$(date +%Y%m%d-%H%M%S)"

echo "== 1. stop any house on port $PORT"
if curl -s -m 2 "http://127.0.0.1:$PORT/healthz" | grep -q '"service":"hmail-house"'; then
  pid=$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
  if [ -n "${pid:-}" ]; then
    kill -INT "$pid"
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid"
    echo "   stopped house (pid $pid)"
  fi
else
  echo "   none running"
fi

echo "== 2. archive the default house (state + house key)"
moved=0
if [ -e "$STATE" ]; then
  mkdir -p "$ARCHIVE"
  mv "$STATE" "$ARCHIVE/state"
  echo "   $STATE -> $ARCHIVE/state"
  moved=1
fi
if [ -e "$HORS/hmail-house" ]; then
  mkdir -p "$ARCHIVE"
  mv "$HORS/hmail-house" "$ARCHIVE/hmail-house"
  echo "   $HORS/hmail-house -> $ARCHIVE/hmail-house"
  moved=1
fi
[ "$moved" = 1 ] || echo "   nothing to archive (already fresh)"

echo "== 3. a free name for this run"
label=""
for n in $(seq 1 99); do
  candidate="$PREFIX$n"
  if curl -s -m 15 "$WEB/api/issue?label=$candidate" | grep -q '"available":true'; then
    label="$candidate"
    break
  fi
done
if [ -n "$label" ]; then
  echo "   use: $label  (-> $label.hmail.eth)"
else
  echo "   could not find a free $PREFIX<N> label; pick any unused name"
fi

cat <<EOF

Ready. This computer has no house now. For the demo:
  - Landing page:  $WEB   (Copy setup prompt -> paste into an assistant on THIS computer)
  - House page:    http://localhost:$PORT   (opens by itself once the house starts)
  - Name to type:  ${label:-<a free name>}

Optional, on the Grok computer (to show the one-time World ID link-up again):
  rm -rf ~/.hors/hmail-assistant
Also log out of the demo site in Grok's Chrome so the login is real.
EOF
