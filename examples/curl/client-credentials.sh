#!/usr/bin/env bash
# BKey — Client Credentials Authentication
# Exchange client_id + client_secret for an access token.

set -euo pipefail

BKEY_API="${BKEY_API_URL:-https://api.bkey.id}"

echo "==> Authenticating with client credentials..."

curl -s -X POST "${BKEY_API}/oauth/token" \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "client_credentials",
    "client_id": "'"${BKEY_CLIENT_ID}"'",
    "client_secret": "'"${BKEY_CLIENT_SECRET}"'"
  }' | python3 -m json.tool
