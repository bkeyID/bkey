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

    def approve(
        self,
        message: str,
        user_did: str,
        scope: str = "approve:action",
        action_details: dict[str, Any] | None = None,
        expiry_seconds: int = 300,
        timeout: int | None = None,
    ) -> CIBAResult:
        """Request biometric approval from the user — one-call CIBA flow.

        Sends a push notification to ``user_did``'s phone. Blocks until the user
        approves (with facial biometrics), denies, or the request expires.

        Args:
            message: Human-readable prompt shown on the approval screen.
            user_did: The BKey DID of the user whose approval is required.
            scope: CIBA scope (default ``approve:action``). Use tight scopes
                per action (e.g. ``approve:deploy``, ``approve:refund``).
            action_details: Optional structured details (type, resource,
                amount, recipient, etc.) rendered on the approval screen.
            expiry_seconds: How long the approval prompt is valid (30-600s).
            timeout: How long to poll for a result in seconds. Defaults to
                ``expiry_seconds`` so we don't stop polling while the phone
                prompt is still live.

        Returns:
            ``CIBAResult`` with ``access_token`` — an EdDSA-signed JWT you
            can verify server-side before acting on the approval.

        Raises:
            ApprovalDeniedError: User denied on device.
            ApprovalTimeoutError: No response within ``timeout``.

        Example::

            client = BKeyClient(client_id=..., client_secret=...)
            result = client.approve(
                message="Deploy api-gateway@abc123 to production",
                user_did="did:bkey:...",
                scope="approve:deploy",
            )
            # result.access_token is the verified approval token
        """
        req = self.initiate_approval(
            user_did=user_did,
            scope=scope,
            binding_message=message,
            action_details=action_details,
            requested_expiry=expiry_seconds,
        )
        # Poll for at least as long as the phone prompt is live.
        poll_timeout = timeout if timeout is not None else expiry_seconds
        result = self.poll_approval(req.auth_req_id, timeout=poll_timeout)
        # poll_approval only raises on 'denied'. An 'expired' result has no
        # access_token; callers of approve() expect a usable token or an
        # exception — don't silently return an unusable result.
        if result.status == "expired":
            raise ApprovalTimeoutError("Approval request expired before the user responded")
        if not result.access_token:
            raise ApprovalDeniedError(f"Approval did not produce a token (status={result.status!r})")
        return result

    def initiate_approval(
        self,
        user_did: str,
        scope: str = "approve:action",
        binding_message: str | None = None,
        action_details: dict[str, Any] | None = None,
        requested_expiry: int | None = None,
    ) -> CIBAResponse:
        """Initiate a CIBA backchannel authorization request.

        Prefer :meth:`approve` for the common case — it handles initiation
        and polling in one call.
        """
        # v0.1.0 shipped with `scope` as the first positional argument and no
        # login_hint — that signature never worked against the real backend
        # (which requires login_hint). Catch the common upgrade mistake where
        # a scope-like string is passed as user_did and produce a clear error
        # instead of a backend 400.
        if not user_did.startswith("did:"):
            raise ValueError(
                f"initiate_approval: user_did must be a BKey DID (got {user_did!r}). "
                "The first positional argument is now user_did — scope is a keyword."
            )
        body: dict[str, Any] = {
            "login_hint": user_did,
            "scope": scope if "openid" in scope.split() else f"openid {scope}",
        }
        if binding_message is not None:
            body["binding_message"] = binding_message
        if action_details is not None:
            body["action_details"] = action_details
        if requested_expiry is not None:
            body["requested_expiry"] = requested_expiry
        data = self._request("POST", "/oauth/bc-authorize", json=body)
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
