#!/usr/bin/env bash
# BKey — Device Authorization Flow (RFC 8628)
# Human login from a CLI or terminal.

set -euo pipefail

BKEY_API="${BKEY_API_URL:-https://api.bkey.id}"

echo "==> Step 1: Request device code..."

RESPONSE=$(curl -s -X POST "${BKEY_API}/oauth/device/authorize" \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "'"${BKEY_CLIENT_ID}"'"
  }')

echo "$RESPONSE" | python3 -m json.tool

DEVICE_CODE=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['device_code'])")
INTERVAL=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('interval', 5))")

echo ""
echo "==> Step 2: Scan the QR code or visit the URL shown above."
echo "==> Step 3: Polling for approval (every ${INTERVAL}s)..."

while true; do
  POLL=$(curl -s -X POST "${BKEY_API}/oauth/token" \
    -H "Content-Type: application/json" \
    -d '{
      "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
      "device_code": "'"${DEVICE_CODE}"'",
      "client_id": "'"${BKEY_CLIENT_ID}"'"
    }')

  if echo "$POLL" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if 'access_token' in d else 1)" 2>/dev/null; then
    echo ""
    echo "==> Approved!"
    echo "$POLL" | python3 -m json.tool
    break
  fi

  echo -n "."
  sleep "$INTERVAL"
done
