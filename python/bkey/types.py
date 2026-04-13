"""Type definitions for BKey SDK — mirrors TypeScript types."""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Optional

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
    refresh_token: Optional[str] = None
    scope: Optional[str] = None


class CIBAResponse(BaseModel):
    """CIBA backchannel authorization response."""

    auth_req_id: str
    expires_in: int
    interval: int


class CIBAResult(BaseModel):
    """Result of polling a CIBA approval."""

    status: str  # "approved", "denied", "pending", "expired"
    access_token: Optional[str] = None
    token_type: Optional[str] = None
    expires_in: Optional[int] = None


class CheckoutItem(BaseModel):
    """A single item in a checkout request."""

    name: str
    price: Decimal
    quantity: int = 1


class CheckoutResponse(BaseModel):
    """Response from initiating a checkout."""

    id: str
    status: str
    ciba_auth_req_id: Optional[str] = None


class CheckoutResult(BaseModel):
    """Result of polling a checkout status."""

    id: str
    status: str  # "pending", "approved", "completed", "rejected", "expired"
    payment_intent_id: Optional[str] = None


class VaultStoreResponse(BaseModel):
    """Response from storing a secret in the vault."""

    id: str
    status: str


class VaultAccessResponse(BaseModel):
    """Response from requesting vault access."""

    id: str
    status: str
    ciba_auth_req_id: Optional[str] = None


class VaultResult(BaseModel):
    """Result of polling vault access."""

    id: str
    status: str  # "pending", "approved", "denied", "expired"
    data: Optional[Any] = None
