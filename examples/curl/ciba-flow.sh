#!/usr/bin/env bash
# BKey — CIBA Flow (Client-Initiated Backchannel Authentication)
# Request biometric approval from a user.

set -euo pipefail

BKEY_API="${BKEY_API_URL:-https://api.bkey.id}"
ACCESS_TOKEN="${BKEY_ACCESS_TOKEN}"

echo "==> Step 1: Initiate CIBA request..."

RESPONSE=$(curl -s -X POST "${BKEY_API}/oauth/bc-authorize" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -d '{
    "scope": "approve:actions",
    "binding_message": "Approve this action from the CLI"
  }')

echo "$RESPONSE" | python3 -m json.tool

AUTH_REQ_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['auth_req_id'])")
INTERVAL=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('interval', 5))")

echo ""
echo "==> Step 2: Approve on your BKey mobile app."
echo "==> Step 3: Polling for approval (every ${INTERVAL}s)..."

while true; do
  POLL=$(curl -s -X POST "${BKEY_API}/oauth/token" \
    -H "Content-Type: application/json" \
    -d '{
      "grant_type": "urn:openid:params:grant-type:ciba",
      "auth_req_id": "'"${AUTH_REQ_ID}"'"
    }')

  STATUS=$(echo "$POLL" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status', d.get('error', 'unknown')))" 2>/dev/null || echo "unknown")

  if [ "$STATUS" = "approved" ] || echo "$POLL" | python3 -c "import sys,json; exit(0 if 'access_token' in json.load(sys.stdin) else 1)" 2>/dev/null; then
    echo ""
    echo "==> Approved!"
    echo "$POLL" | python3 -m json.tool
    break
  elif [ "$STATUS" = "denied" ]; then
    echo ""
    echo "==> Denied."
    exit 1
  fi

  echo -n "."
  sleep "$INTERVAL"
done
