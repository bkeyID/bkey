"""Type definitions for BKey SDK — mirrors TypeScript types."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from pydantic import BaseModel


class BKeyConfig(BaseModel):
    """Configuration for BKeyClient."""

    client_id: str
    client_secret: str
    base_url: str = "https://api.bkey.id"


class TokenResponse(BaseModel):
    """OAuth token response."""

    access_token: str
    token_type: str = "Bearer"
    expires_in: int
    refresh_token: str | None = None
    scope: str | None = None


class CIBAResponse(BaseModel):
    """CIBA backchannel authorization response."""

    auth_req_id: str
    expires_in: int
    interval: int


class CIBAResult(BaseModel):
    """Result of polling a CIBA approval."""

    status: str  # "approved", "denied", "pending", "expired"
    access_token: str | None = None
    token_type: str | None = None
    expires_in: int | None = None


class CheckoutItem(BaseModel):
    """A single item in a checkout request."""

    name: str
    price: Decimal
    quantity: int = 1


class CheckoutResponse(BaseModel):
    """Response from initiating a checkout."""

    id: str
    status: str
    ciba_auth_req_id: str | None = None


class CheckoutResult(BaseModel):
    """Result of polling a checkout status."""

    id: str
    status: str  # "pending", "approved", "completed", "rejected", "expired"
    payment_intent_id: str | None = None


class VaultStoreResponse(BaseModel):
    """Response from storing a secret in the vault."""

    id: str
    status: str


class VaultAccessResponse(BaseModel):
    """Response from requesting vault access."""

    id: str
    status: str
    ciba_auth_req_id: str | None = None


class VaultResult(BaseModel):
    """Result of polling vault access."""

    id: str
    status: str  # "pending", "approved", "denied", "expired"
    data: Any | None = None
