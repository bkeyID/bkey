"""Python vault-access example.

Shows how a Python program reads an encrypted secret from the BKey vault
and uses it, after the user approves on their phone with Face ID.

Two patterns side-by-side:

  1. Generic one-line CIBA approval — the universal pattern for any
     sensitive action. `client.approve(...)` returns a signed JWT proving
     the user consented.

  2. Vault access via `bkey wrap` — the recommended way to pull an E2EE
     secret into your Python process. The CLI handles X25519 ECDH and
     AES-256-GCM decryption so you don't have to.

Prereqs:
  - Install the BKey CLI: npm install -g @bkey/cli
  - Create agent credentials: bkey auth login && bkey auth setup-agent --save
  - Store a test secret: bkey vault store openai-api-key --field value=sk-test-...
  - Copy .env.example → .env and fill it in.

Run:
  python access.py
"""

import os
import subprocess
import sys
from pathlib import Path

from bkey import BKeyClient
from bkey.exceptions import ApprovalDeniedError, ApprovalTimeoutError

ITEM_NAME = "openai-api-key"


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


def demo_generic_approval(client: BKeyClient, user_did: str) -> None:
    print("=" * 60)
    print("Part 1: Generic biometric approval")
    print("=" * 60)
    print("Approve the prompt on the user's phone (Face ID)...")
    try:
        result = client.approve(
            message="Python example — read a vault secret",
            user_did=user_did,
            scope="approve:action",
        )
    except ApprovalDeniedError:
        print("Denied on device. Aborting.")
        sys.exit(1)
    except ApprovalTimeoutError:
        print("Timed out waiting for approval.")
        sys.exit(1)

    token_preview = (result.access_token or "")[:24]
    print(f"Approved. JWT starts with: {token_preview}...\n")


def demo_vault_access_via_cli() -> None:
    print("=" * 60)
    print("Part 2: Vault access (E2EE via `bkey wrap`)")
    print("=" * 60)
    print(f'Reading vault item "{ITEM_NAME}" — phone will prompt for approval.')
    print("`bkey wrap` handles X25519 ECDH + AES-256-GCM decryption, then")
    print("injects the plaintext value into this subprocess as an env var.\n")

    inner_script = (
        "import os;"
        "key = os.environ.get('OPENAI_API_KEY', '');"
        "print(f'Key loaded (len={len(key)}, prefix={key[:5]})') "
        "if key else print('Key missing')"
    )
    cmd = [
        "bkey", "wrap",
        "--env", f"OPENAI_API_KEY={{vault:{ITEM_NAME}}}",
        "--purpose", "Python example: read OpenAI key",
        "--",
        sys.executable, "-c", inner_script,
    ]

    try:
        subprocess.run(cmd, check=True)
    except FileNotFoundError:
        print(
            "`bkey` CLI not found on PATH. Install it: `npm install -g @bkey/cli`."
        )
    except subprocess.CalledProcessError as err:
        print(f"Vault access failed (exit {err.returncode}).")


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

    demo_generic_approval(client, user_did)
    demo_vault_access_via_cli()


if __name__ == "__main__":
    main()
