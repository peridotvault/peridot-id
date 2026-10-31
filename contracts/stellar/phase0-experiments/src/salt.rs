//! Experiment 2 (part 1): counterfactual salt derivation.
//!
//! Salt = sha256(lowercased-trimmed PID), byte-identical to the `pidToSeed32`
//! convention in `packages/core/src/bytes.ts` (also the EVM CREATE2 salt via
//! `pidToSalt32` and the SVM PDA seed). On Soroban the deployer salt is this
//! 32-byte value passed to `env.deployer().with_address(deployer, salt)`, and
//! `deployed_address()` predicts the contract ID pre-deployment — the
//! CREATE2-counterfactual / PDA analogue. Part 2 (on-chain parity assertion)
//! runs on testnet per RUNBOOK.md experiment 2.

use sha2::{Digest, Sha256};

/// Normalize exactly like `pidToSeed32`: trim + lowercase (ASCII).
pub fn normalize_pid(pid: &str) -> String {
    pid.trim().to_lowercase()
}

/// 32-byte deployer salt for a PID.
pub fn pid_to_salt32(pid: &str) -> [u8; 32] {
    let normalized = normalize_pid(pid);
    assert!(!normalized.is_empty(), "invalid pid");
    let digest = Sha256::digest(normalized.as_bytes());
    let mut salt = [0u8; 32];
    salt.copy_from_slice(&digest);
    salt
}

/// Fail-closed salt-length gate (S1 AC1.7): the factory accepts exactly 32
/// bytes. Truncated (u32/u64-shaped), padded, or empty salts from old
/// fixtures are rejected before deploy — no silent truncation.
///
/// Gas: zero (pure length check, no hashing).
/// Reentrancy: N/A (no external calls).
/// Access: deployer-side check, least privilege preserved.
pub fn check_salt_len(salt: &[u8]) -> Result<(), &'static str> {
    if salt.len() == 32 {
        Ok(())
    } else {
        Err("invalid salt: factory accepts exactly 32 bytes")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{:02x}", x)).collect()
    }

    /// Cross-checked against `packages/core` `pidToSeed32` (node, 2026-10-25).
    #[test]
    fn salt_matches_typescript_pid_to_seed32_vectors() {
        // node: pidToSeed32('ifal@pid')
        assert_eq!(
            hex(&pid_to_salt32("ifal@pid")),
            "98bc15cccd4fd3a85b71e5b29b430d0cc461e7b5ebb7ac1b13428299ce52cfe7"
        );
        // Normalization: case + surrounding whitespace fold to the same salt.
        assert_eq!(
            hex(&pid_to_salt32("TEST@PID")),
            "d7824b7df5f3b280b67abf3ac397749789aa4b6bac508d9b0df69091cb3a0cfa"
        );
        assert_eq!(
            hex(&pid_to_salt32("  Alice@PID  ")),
            "12fcda9267d62d47b2aebd88a35cc04c5d929d0ddc3b1c14799c04fa233eef4e"
        );
    }

    /// Rotation stability: the salt (hence the counterfactual address) does
    /// not change when the signer rotates — same property asserted by the
    /// forge `deriveEvmSmartAccountAddress` parity test on EVM.
    #[test]
    fn salt_stable_across_signer_rotation() {
        let before = pid_to_salt32("carol@pid");
        let after = pid_to_salt32("  CAROL@PID ");
        assert_eq!(before, after);
    }

    #[test]
    #[should_panic(expected = "invalid pid")]
    fn empty_pid_rejected() {
        let _ = pid_to_salt32("   ");
    }

    /// S1 AC1.6: distinct pids yield distinct contract IDs (collision sanity).
    #[test]
    fn distinct_pids_yield_distinct_salts() {
        let a = pid_to_salt32("alice@pid");
        let b = pid_to_salt32("bob@pid");
        assert_ne!(a, b);
        // Phase-0 fixture pair is distinct as well (Exp-2 CCGI… vs CDD37… analogue).
        assert_ne!(pid_to_salt32("ifal@pid"), pid_to_salt32("TEST@PID"));
    }

    /// S1 AC1.7: non-32B salts (truncated u32/u64 fixtures, padded, empty)
    /// fail closed before deploy — the factory accepts exactly 32 bytes.
    #[test]
    fn non_32b_salt_rejected_fail_closed() {
        assert!(check_salt_len(&pid_to_salt32("ifal@pid")).is_ok());
        assert!(check_salt_len(&[0u8; 4]).is_err()); // truncated u32 fixture shape
        assert!(check_salt_len(&[0u8; 8]).is_err()); // u64 shape
        assert!(check_salt_len(&[]).is_err()); // empty
        assert!(check_salt_len(&[0u8; 31]).is_err());
        assert!(check_salt_len(&[0u8; 33]).is_err()); // padded
    }
}
