"""BKey agent-initiated checkout.

Demonstrates the pattern where an agent (or any automated system) initiates
a purchase on behalf of a user, and the user approves it biometrically on
their phone before payment is captured.

Flow:
  1. Agent calls ``checkout_request()`` → BKey pushes an approval prompt to
     the user's phone.
  2. Agent polls via ``checkout_poll()`` → blocks until the user approves,
     rejects, or the request expires.
  3. On approval, the returned ``payment_intent_id`` can be handed to a
     payment processor (Stripe, etc.) to capture the charge.

Replace the print at the end with your real post-approval action — charge a
payment method, write to an order log, trigger fulfillment, whatever.
"""

from __future__ import annotations

import argparse
import os
import sys
from decimal import Decimal, InvalidOperation
from typing import Any

from bkey import BKeyClient
from bkey.exceptions import ApprovalDeniedError, ApprovalTimeoutError, BKeyError


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        print(f"error: {name} is not set — see .env.example", file=sys.stderr)
        sys.exit(2)
    return value


def _parse_item(raw: str) -> dict[str, Any]:
    """Parse a CLI ``--item NAME:PRICE[:QUANTITY]`` argument."""
    parts = raw.split(":")
    if len(parts) < 2 or len(parts) > 3:
        raise argparse.ArgumentTypeError(
            f"expected NAME:PRICE or NAME:PRICE:QUANTITY, got {raw!r}"
        )
    name = parts[0].strip()
    if not name:
        raise argparse.ArgumentTypeError("item name cannot be empty")
    try:
        price = Decimal(parts[1])
    except InvalidOperation as e:
        raise argparse.ArgumentTypeError(f"invalid price {parts[1]!r}") from e
    quantity = int(parts[2]) if len(parts) == 3 else 1
    return {"name": name, "price": float(price), "quantity": quantity}


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="bkey-agent-checkout",
        description=(
            "BKey agent-checkout example. Initiates a checkout on behalf of a "
            "user and blocks until they approve on their phone."
        ),
    )
    parser.add_argument(
        "--merchant",
        default="Example Store",
        help="Merchant name shown on the approval prompt (default: %(default)r).",
    )
    parser.add_argument(
        "--currency",
        default="USD",
        help="ISO-4217 currency code (default: %(default)r).",
    )
    parser.add_argument(
        "--item",
        dest="items",
        action="append",
        type=_parse_item,
        default=[],
        metavar="NAME:PRICE[:QTY]",
        help="Line item, repeatable. Example: --item Widget:9.99:2.",
    )
    parser.add_argument(
        "--amount",
        type=Decimal,
        default=None,
        help=(
            "Explicit total. If omitted, computed as sum(price * quantity) "
            "across --item args."
        ),
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=120,
        help="Seconds to wait for user approval (default: %(default)s).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    if not args.items:
        # Default line item so the example runs end-to-end with no flags.
        args.items = [{"name": "Widget", "price": 9.99, "quantity": 1}]

    if args.amount is None:
        total = sum(
            (Decimal(str(item["price"])) * item["quantity"] for item in args.items),
            Decimal("0"),
        )
    else:
        total = args.amount

    client_id = _require_env("BKEY_CLIENT_ID")
    client_secret = _require_env("BKEY_CLIENT_SECRET")
    base_url = os.environ.get("BKEY_API_URL", "https://api.bkey.id")

    client = BKeyClient(
        client_id=client_id,
        client_secret=client_secret,
        base_url=base_url,
    )

    print(f"==> Requesting checkout: {args.merchant} — {total} {args.currency}")
    try:
        checkout = client.checkout_request(
            merchant_name=args.merchant,
            items=args.items,
            amount=float(total),
            currency=args.currency,
        )
    except BKeyError as err:
        print(f"error: checkout_request failed: {err}", file=sys.stderr)
        return 1

    print(f"    checkout id: {checkout.id}")
    print("    approve on your phone …")

    try:
        result = client.checkout_poll(checkout.id, timeout=args.timeout)
    except ApprovalDeniedError:
        print("==> rejected by user", file=sys.stderr)
        return 1
    except ApprovalTimeoutError as err:
        print(f"==> timed out: {err}", file=sys.stderr)
        return 1
    except BKeyError as err:
        print(f"error: checkout_poll failed: {err}", file=sys.stderr)
        return 1

    print(f"==> {result.status}")
    if result.payment_intent_id:
        print(f"    payment_intent_id: {result.payment_intent_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
