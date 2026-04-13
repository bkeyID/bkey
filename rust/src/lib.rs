//! BKey SDK — biometric approval, vault, and checkout for AI agents.
//!
//! This crate is under development. See <https://bkey.id/docs> for documentation
//! and <https://github.com/bkeyID/bkey> for the source.

/// Placeholder — full SDK coming soon.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_works() {
        assert_eq!(version(), "0.1.0");
    }
}
