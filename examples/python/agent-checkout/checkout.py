"""Python agent-checkout example.

Demonstrates both patterns side-by-side:

  1. Generic one-line CIBA approval — the universal pattern for any
     sensitive action (deploy, refund, DB write, admin grant, etc.).

  2. Structured checkout — the same CIBA primitive with checkout-specific
     fields (merchant, items, amount) rendered on the user's phone.

Prereqs:
  - Install the BKey CLI: npm install -g @bkey/cli
  - Create agent credentials: bkey auth login && bkey auth setup-agent --save
  - Copy .env.example → .env and fill in the values.

Run:
  python checkout.py
"""

import os
import sys
from pathlib import Path

from bkey import BKeyClient
from bkey.exceptions import ApprovalDeniedError, ApprovalTimeoutError


def _load_env() -> None:
    env_path = Path(__file__).with_name(".env")
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def main() -> None:
    _load_env()

    client_id = os.environ.get("BKEY_CLIENT_ID")
    client_secret = os.environ.get("BKEY_CLIENT_SECRET")
    user_did = os.environ.get("BKEY_USER_DID")
    base_url = os.environ.get("BKEY_API_URL", "https://api.bkey.id")

    if not (client_id and client_secret and user_did):
        print(
            "Missing credentials. Set BKEY_CLIENT_ID, BKEY_CLIENT_SECRET, "
            "BKEY_USER_DID in .env (copy from .env.example)."
        )
        sys.exit(1)

    client = BKeyClient(
        client_id=client_id,
        client_secret=client_secret,
        base_url=base_url,
    )

    # ── Part 1: Generic CIBA approval (one line) ──────────────────────
    print("=" * 60)
    print("Part 1: Generic biometric approval")
    print("=" * 60)
    print("Requesting approval on the user's phone (check Face ID prompt)...")
    try:
        result = client.approve(
            message="Proceed with a test action (example agent)",
            user_did=user_did,
            scope="approve:action",
        )
    except ApprovalDeniedError:
        print("Denied on device. Exiting.")
        return
    except ApprovalTimeoutError:
        print("No response within timeout. Exiting.")
        return

    print(f"Approved. Access token starts with: {(result.access_token or '')[:24]}...")
    print("(Verify this JWT server-side with the /oauth/jwks endpoint before acting on it.)\n")

    # ── Part 2: Structured checkout (same CIBA primitive, richer UI) ──
    print("=" * 60)
    print("Part 2: Structured checkout")
    print("=" * 60)
    checkout = client.checkout_request(
        merchant_name="BKey Demo Store",
        items=[
            {"name": "Widget", "price": 9.99, "quantity": 1},
            {"name": "Gadget", "price": 14.99, "quantity": 2},
        ],
        amount=39.97,
        currency="USD",
    )
    print(f"Checkout initiated: {checkout.id}")
    print("Approve on the phone. The screen shows merchant + items + total.\n")

    try:
        outcome = client.checkout_poll(checkout.id)
    except ApprovalDeniedError:
        print("Customer rejected the checkout.")
        return
    except ApprovalTimeoutError:
        print("Checkout expired without a decision.")
        return

    print(f"Checkout {outcome.status}.")
    if outcome.payment_intent_id:
        print(f"Payment intent: {outcome.payment_intent_id}")


if __name__ == "__main__":
    main()
