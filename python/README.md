# bkey

Python SDK for BKey — biometric approval, vault, and checkout for AI agents.

## Installation

```bash
pip install bkey-sdk              # Core (requests)
pip install bkey-sdk[async]       # + httpx for async
pip install bkey-sdk[all]         # Everything
```

## Quick Start

```python
from bkey import BKeyClient

client = BKeyClient(
    client_id="your-client-id",
    client_secret="your-client-secret",
)

# Request a checkout approval
checkout = client.checkout_request(
    merchant_name="Example Store",
    items=[{"name": "Widget", "price": 9.99}],
    amount=9.99,
    currency="USD",
)

# Wait for user to approve on their phone
result = client.checkout_poll(checkout.id)
print(result.status)  # "approved"
```

## Documentation

See [bkey.id/docs](https://bkey.id/docs) for full documentation.
