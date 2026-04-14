"""BKey client — biometric approval, vault, and checkout for AI agents."""

from __future__ import annotations

import time
from typing import Any

import requests

from bkey.exceptions import (
    APIError,
    ApprovalDeniedError,
    ApprovalTimeoutError,
    AuthenticationError,
)
from bkey.types import (
    BKeyConfig,
    CIBAResponse,
    CIBAResult,
    CheckoutResponse,
    CheckoutResult,
    TokenResponse,
    VaultAccessResponse,
    VaultResult,
    VaultStoreResponse,
)


class BKeyClient:
    """Synchronous BKey client.

    Usage::

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

        # Wait for user to approve on phone
        result = client.checkout_poll(checkout.id)
    """

    def __init__(
        self,
        client_id: str | None = None,
        client_secret: str | None = None,
        base_url: str = "https://api.bkey.id",
        access_token: str | None = None,
    ):
        self._config = BKeyConfig(
            client_id=client_id or "",
            client_secret=client_secret or "",
            base_url=base_url.rstrip("/"),
        )
        self._access_token = access_token
        self._token_expires_at: float = 0
        self._refresh_token: str | None = None
        self._session = requests.Session()

    def _ensure_token(self) -> str:
        """Get a valid access token, refreshing if needed."""
        if self._access_token and time.time() < self._token_expires_at:
            return self._access_token

        if self._refresh_token:
            token = self.refresh_token()
        else:
            token = self.authenticate()

        self._access_token = token.access_token
        self._token_expires_at = time.time() + token.expires_in - 30
        if token.refresh_token:
            self._refresh_token = token.refresh_token
        return self._access_token

    def _request(
        self,
        method: str,
        path: str,
        json: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        auth: bool = True,
    ) -> dict[str, Any]:
        """Make an authenticated HTTP request."""
        url = f"{self._config.base_url}{path}"
        headers: dict[str, str] = {}

        if auth:
            token = self._ensure_token()
            headers["Authorization"] = f"Bearer {token}"

        resp = self._session.request(
            method, url, json=json, data=data, params=params, headers=headers, timeout=30,
        )

        if resp.status_code >= 400:
            try:
                body = resp.json()
                msg = body.get("error", {}).get("message", resp.text)
                err_type = body.get("error", {}).get("type")
            except Exception:
                msg = resp.text
                err_type = None
            raise APIError(resp.status_code, msg, err_type)

        return resp.json()

    # ── Auth ────────────────────────────────────────────────────────────

    def authenticate(self) -> TokenResponse:
        """Authenticate using client credentials (form-encoded per OAuth 2.1 spec)."""
        resp_data = self._request(
            "POST",
            "/oauth/token",
            data={
                "grant_type": "client_credentials",
                "client_id": self._config.client_id,
                "client_secret": self._config.client_secret,
            },
            auth=False,
        )
        return TokenResponse(**resp_data)

    def refresh_token(self) -> TokenResponse:
        """Refresh the access token (form-encoded per OAuth 2.1 spec)."""
        if not self._refresh_token:
            raise AuthenticationError("No refresh token available")
        resp_data = self._request(
            "POST",
            "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "refresh_token": self._refresh_token,
                "client_id": self._config.client_id,
                "client_secret": self._config.client_secret,
            },
            auth=False,
        )
        return TokenResponse(**resp_data)

    # ── CIBA ────────────────────────────────────────────────────────────

    def initiate_approval(
        self,
        scope: str,
        binding_message: str | None = None,
    ) -> CIBAResponse:
        """Initiate a CIBA backchannel authorization request."""
        data = self._request(
            "POST",
            "/oauth/bc-authorize",
            json={
                "scope": scope,
                "binding_message": binding_message,
            },
        )
        return CIBAResponse(**data)

    def poll_approval(
        self,
        auth_req_id: str,
        timeout: int = 120,
    ) -> CIBAResult:
        """Poll a CIBA approval until resolved or timeout (form-encoded per OAuth 2.1 spec)."""
        interval = 5
        deadline = time.time() + timeout

        while time.time() < deadline:
            data = self._request(
                "POST",
                "/oauth/token",
                data={
                    "grant_type": "urn:openid:params:grant-type:ciba",
                    "auth_req_id": auth_req_id,
                    "client_id": self._config.client_id,
                    "client_secret": self._config.client_secret,
                },
                auth=False,
            )
            result = CIBAResult(**data)
            if result.status != "pending":
                if result.status == "denied":
                    raise ApprovalDeniedError("User denied the approval request")
                return result
            time.sleep(interval)

        raise ApprovalTimeoutError(f"Approval timed out after {timeout}s")

    # ── Vault ───────────────────────────────────────────────────────────

    def vault_store(
        self,
        key: str,
        value: str,
        metadata: dict[str, Any] | None = None,
    ) -> VaultStoreResponse:
        """Store a secret in the vault.

        Note: The Python SDK does not yet implement client-side E2EE
        (end-to-end encryption). Secrets are sent over TLS but are
        visible to the server. For E2EE vault storage, use the
        TypeScript CLI (``bkey vault store``) or ``@bkey/sdk``.
        """
        data = self._request(
            "POST",
            "/v1/vault/store",
            json={"key": key, "value": value, "metadata": metadata},
        )
        return VaultStoreResponse(**data)

    def vault_access(self, item_id: str) -> VaultAccessResponse:
        """Request access to a stored vault item (triggers biometric approval)."""
        data = self._request("POST", f"/v1/vault/{item_id}/access")
        return VaultAccessResponse(**data)

    def vault_poll(self, item_id: str, timeout: int = 120) -> VaultResult:
        """Poll vault access until approved or timeout."""
        interval = 3
        deadline = time.time() + timeout

        while time.time() < deadline:
            data = self._request("GET", f"/v1/vault/{item_id}/status")
            result = VaultResult(**data)
            if result.status != "pending":
                if result.status == "denied":
                    raise ApprovalDeniedError("User denied vault access")
                return result
            time.sleep(interval)

        raise ApprovalTimeoutError(f"Vault access timed out after {timeout}s")

    # ── Checkout ────────────────────────────────────────────────────────

    def checkout_request(
        self,
        merchant_name: str,
        items: list[dict[str, Any]],
        amount: float,
        currency: str = "USD",
    ) -> CheckoutResponse:
        """Initiate a checkout request (triggers biometric approval on phone)."""
        data = self._request(
            "POST",
            "/v1/checkout/initiate",
            json={
                "merchantName": merchant_name,
                "items": items,
                "amount": amount,
                "currency": currency,
            },
        )
        return CheckoutResponse(**data)

    def checkout_poll(self, checkout_id: str, timeout: int = 120) -> CheckoutResult:
        """Poll checkout status until resolved or timeout."""
        interval = 3
        deadline = time.time() + timeout

        while time.time() < deadline:
            data = self._request("GET", f"/v1/checkout/{checkout_id}/status")
            result = CheckoutResult(**data)
            if result.status not in ("pending",):
                if result.status == "rejected":
                    raise ApprovalDeniedError("User rejected the checkout")
                return result
            time.sleep(interval)

        raise ApprovalTimeoutError(f"Checkout timed out after {timeout}s")
