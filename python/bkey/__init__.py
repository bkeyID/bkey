"""BKey SDK — biometric approval, vault, and checkout for AI agents."""

__version__ = "0.1.0"


def __getattr__(name: str):
    if name == "BKeyClient":
        from bkey.client import BKeyClient

        return BKeyClient
    if name in ("BKeyConfig", "CIBAResponse", "CheckoutResponse", "VaultStoreResponse"):
        from bkey import types

        return getattr(types, name)
    raise AttributeError(f"module 'bkey' has no attribute {name!r}")


__all__ = [
    "BKeyClient",
    "BKeyConfig",
    "CIBAResponse",
    "CheckoutResponse",
    "VaultStoreResponse",
]
