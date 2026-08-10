"""Typed exceptions for BKey SDK."""


class BKeyError(Exception):
    """Base exception for all BKey errors."""


class AuthenticationError(BKeyError):
    """Failed to authenticate with BKey API."""


class ApprovalDeniedError(BKeyError):
    """The user denied the approval request."""


class ApprovalTimeoutError(BKeyError):
    """The approval request timed out waiting for user action."""


class APIError(BKeyError):
    """HTTP error from BKey API."""

    def __init__(self, status_code: int, message: str, error_type: str | None = None):
        self.status_code = status_code
        self.error_type = error_type
        super().__init__(f"BKey API error {status_code}: {message}")
