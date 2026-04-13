#!/usr/bin/env bash
# BKey — Checkout Flow
# Initiate a purchase and wait for biometric approval.

set -euo pipefail

BKEY_API="${BKEY_API_URL:-https://api.bkey.id}"
ACCESS_TOKEN="${BKEY_ACCESS_TOKEN}"

echo "==> Step 1: Initiate checkout..."

RESPONSE=$(curl -s -X POST "${BKEY_API}/v1/checkout/initiate" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -d '{
    "merchantName": "Example Store",
    "items": [{"name": "Widget", "price": 9.99, "quantity": 1}],
    "amount": 9.99,
    "currency": "USD"
  }')

echo "$RESPONSE" | python3 -m json.tool

CHECKOUT_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

echo ""
echo "==> Step 2: Approve on your BKey mobile app."
echo "==> Step 3: Polling for status..."

while true; do
  POLL=$(curl -s -X GET "${BKEY_API}/v1/checkout/${CHECKOUT_ID}/status" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}")

  STATUS=$(echo "$POLL" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")

  if [ "$STATUS" = "approved" ] || [ "$STATUS" = "completed" ]; then
    echo ""
    echo "==> ${STATUS}!"
    echo "$POLL" | python3 -m json.tool
    break
  elif [ "$STATUS" = "rejected" ] || [ "$STATUS" = "expired" ]; then
    echo ""
    echo "==> ${STATUS}."
    echo "$POLL" | python3 -m json.tool
    exit 1
  fi

  echo -n "."
  sleep 3
done
