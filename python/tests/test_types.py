"""Tests for BKey SDK types."""

from decimal import Decimal

from bkey.types import (
    BKeyConfig,
    CIBAResponse,
    CIBAResult,
    CheckoutItem,
    CheckoutResponse,
    CheckoutResult,
    TokenResponse,
    VaultAccessResponse,
    VaultResult,
    VaultStoreResponse,
)


def test_bkey_config_defaults():
    config = BKeyConfig(client_id="cid", client_secret="csec")
    assert config.base_url == "https://api.bkey.id"


def test_bkey_config_custom_url():
    config = BKeyConfig(client_id="cid", client_secret="csec", base_url="http://localhost:8080")
    assert config.base_url == "http://localhost:8080"


def test_token_response():
    resp = TokenResponse(access_token="tok", expires_in=3600)
    assert resp.token_type == "Bearer"
    assert resp.refresh_token is None


def test_ciba_response():
    resp = CIBAResponse(auth_req_id="ciba_123", expires_in=300, interval=5)
    assert resp.auth_req_id == "ciba_123"


def test_ciba_result_pending():
    result = CIBAResult(status="pending")
    assert result.access_token is None


def test_ciba_result_approved():
    result = CIBAResult(status="approved", access_token="tok", token_type="Bearer", expires_in=300)
    assert result.access_token == "tok"


def test_checkout_item():
    item = CheckoutItem(name="Widget", price=Decimal("9.99"))
    assert item.quantity == 1


def test_checkout_response():
    resp = CheckoutResponse(id="chk_123", status="pending")
    assert resp.ciba_auth_req_id is None


def test_checkout_result():
    result = CheckoutResult(id="chk_123", status="approved")
    assert result.payment_intent_id is None


def test_vault_store_response():
    resp = VaultStoreResponse(id="v_123", status="pending")
    assert resp.id == "v_123"


def test_vault_access_response():
    resp = VaultAccessResponse(id="v_123", status="pending")
    assert resp.ciba_auth_req_id is None


def test_vault_result_with_data():
    result = VaultResult(id="v_123", status="approved", data={"key": "secret"})
    assert result.data == {"key": "secret"}
