"""Tests for BKey SDK exceptions."""

from bkey.exceptions import (
    APIError,
    ApprovalDeniedError,
    ApprovalTimeoutError,
    AuthenticationError,
    BKeyError,
)


def test_exception_hierarchy():
    assert issubclass(AuthenticationError, BKeyError)
    assert issubclass(ApprovalDeniedError, BKeyError)
    assert issubclass(ApprovalTimeoutError, BKeyError)
    assert issubclass(APIError, BKeyError)


def test_api_error_attributes():
    err = APIError(400, "Bad request", "VALIDATION_ERROR")
    assert err.status_code == 400
    assert err.error_type == "VALIDATION_ERROR"
    assert "400" in str(err)
    assert "Bad request" in str(err)
