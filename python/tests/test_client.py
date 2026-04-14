"""Tests for BKey SDK client."""

from unittest.mock import MagicMock, patch

import pytest

from bkey.client import BKeyClient
from bkey.exceptions import APIError, AuthenticationError


def test_client_default_base_url():
    client = BKeyClient(client_id="cid", client_secret="csec")
    assert client._config.base_url == "https://api.bkey.id"


def test_client_strips_trailing_slash():
    client = BKeyClient(client_id="cid", client_secret="csec", base_url="http://localhost:8080/")
    assert client._config.base_url == "http://localhost:8080"


def test_client_with_access_token():
    client = BKeyClient(access_token="direct-token")
    assert client._access_token == "direct-token"


def test_authenticate_uses_form_encoded():
    """OAuth token requests must use application/x-www-form-urlencoded, not JSON."""
    client = BKeyClient(client_id="cid", client_secret="csec")

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "access_token": "tok",
        "token_type": "Bearer",
        "expires_in": 3600,
    }

    with patch.object(client._session, "request", return_value=mock_response) as mock_req:
        token = client.authenticate()

        assert token.access_token == "tok"
        call_kwargs = mock_req.call_args
        # data= means form-encoded, json= means JSON body
        assert call_kwargs.kwargs.get("data") is not None or "data" in str(call_kwargs)
        assert call_kwargs.kwargs.get("json") is None


def test_refresh_token_without_token_raises():
    client = BKeyClient(client_id="cid", client_secret="csec")
    with pytest.raises(AuthenticationError, match="No refresh token"):
        client.refresh_token()


def test_api_error_on_4xx():
    client = BKeyClient(client_id="cid", client_secret="csec", access_token="tok")
    client._token_expires_at = float("inf")  # prevent re-auth

    mock_response = MagicMock()
    mock_response.status_code = 400
    mock_response.text = "Bad request"
    mock_response.json.return_value = {
        "error": {"type": "VALIDATION_ERROR", "message": "Amount is required"},
    }

    with patch.object(client._session, "request", return_value=mock_response):
        with pytest.raises(APIError) as exc_info:
            client.checkout_request("Store", [{"name": "X", "price": 1}], 1.0)

        assert exc_info.value.status_code == 400
        assert "Amount is required" in str(exc_info.value)


def test_request_includes_timeout():
    """All HTTP requests must include a timeout."""
    client = BKeyClient(client_id="cid", client_secret="csec", access_token="tok")
    client._token_expires_at = float("inf")

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"id": "v1", "status": "ok"}

    with patch.object(client._session, "request", return_value=mock_response) as mock_req:
        client.vault_store("key", "value")
        call_kwargs = mock_req.call_args
        assert call_kwargs.kwargs.get("timeout") == 30


def test_vault_store_plaintext_warning():
    """vault_store docstring should warn about no E2EE."""
    assert "E2EE" in BKeyClient.vault_store.__doc__
