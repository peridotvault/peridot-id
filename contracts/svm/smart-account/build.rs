//! Build script: bakes the backend allowlist and canonical treasury into the program.
//!
//! `PID_BACKEND` (base58, the Peridot relayer pubkey for this environment)
//! becomes `config::BACKEND`. Creation paths (`initialize`, `activate`) require
//! the payer/relayer to equal it — this is what binds a PID to a real user
//! (only the backend knows the pid↔identity mapping), so a stranger can neither
//! squat a PDA nor divert a pre-funded deposit.
//!
//! `PID_TREASURY` (base58) becomes `config::TREASURY`, the single canonical V1
//! recipient of protocol markup. It defaults to `PID_BACKEND` when unset. Neither
//! constant enters PDA derivation: builds are env-specific by design (same program
//! id everywhere, backend/treasury consts per cluster). Local tests set both to
//! the test keypair.
//!
//! Unset `PID_BACKEND` fails closed to `[0u8; 32]` (no caller matches — creation
//! disabled).

use std::path::PathBuf;

const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

fn decode_base58(s: &str) -> Vec<u8> {
    let mut num: Vec<u32> = vec![0];
    for c in s.bytes() {
        let mut carry = ALPHABET.iter().position(|&a| a == c).expect("PID_BACKEND must be base58") as u32;
        for d in num.iter_mut() {
            let v = (*d as u64) * 58 + carry as u64;
            *d = v as u32;
            carry = (v >> 32) as u32;
        }
        // carry is always < 59 here (d < 2^32), so one push consumes it.
        if carry > 0 {
            num.push(carry);
        }
    }
    let mut bytes = Vec::new();
    for d in num.iter().rev() {
        bytes.extend_from_slice(&d.to_be_bytes());
    }
    let bytes: Vec<u8> = bytes.into_iter().skip_while(|&b| b == 0).collect();
    let leading = s.bytes().take_while(|&b| b == b'1').count();
    let mut out = vec![0u8; leading];
    out.extend(bytes);
    out
}

fn parse_pubkey(var: &str, what: &str) -> Option<Vec<u8>> {
    match std::env::var(var) {
        Ok(s) => {
            let raw = decode_base58(s.trim());
            assert!(raw.len() == 32, "{what} must decode to 32 bytes");
            Some(raw)
        }
        Err(_) => None,
    }
}

fn main() {
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("config.rs");
    let backend = match parse_pubkey("PID_BACKEND", "PID_BACKEND") {
        Some(raw) => raw,
        None => {
            println!("cargo:warning=PID_BACKEND unset — creation paths disabled (fail-closed zeros)");
            vec![0u8; 32]
        }
    };
    let treasury = match parse_pubkey("PID_TREASURY", "PID_TREASURY") {
        Some(raw) => raw,
        None => {
            println!("cargo:warning=PID_TREASURY unset — defaulting canonical treasury to PID_BACKEND");
            backend.clone()
        }
    };
    let backend_lit = backend.iter().map(|b| b.to_string()).collect::<Vec<_>>().join(", ");
    let treasury_lit = treasury.iter().map(|b| b.to_string()).collect::<Vec<_>>().join(", ");
    std::fs::write(
        &out,
        format!(
            "pub const BACKEND: [u8; 32] = [{backend_lit}];\npub const TREASURY: [u8; 32] = [{treasury_lit}];\n",
        ),
    )
    .unwrap();
    println!("cargo:rerun-if-env-changed=PID_BACKEND");
    println!("cargo:rerun-if-env-changed=PID_TREASURY");
}
