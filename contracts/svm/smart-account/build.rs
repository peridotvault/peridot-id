//! Build script: bakes the backend allowlist into the program.
//!
//! `PID_BACKEND` (base58, the Peridot relayer/treasury-float pubkey for this
//! environment) becomes `config::BACKEND`. Creation paths (`initialize`,
//! `activate`) require the payer/relayer to equal it — this is what binds a PID
//! to a real user (only the backend knows the pid↔identity mapping), so a
//! stranger can neither squat a PDA nor divert a pre-funded deposit.
//!
//! Unset `PID_BACKEND` fails closed to `[0u8; 32]` (no caller matches — creation
//! disabled). Builds are env-specific by design: same program id everywhere,
//! backend const per cluster. Local tests set `PID_BACKEND` to the test keypair.

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

fn main() {
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("config.rs");
    let backend = match std::env::var("PID_BACKEND") {
        Ok(s) => {
            let raw = decode_base58(s.trim());
            assert!(raw.len() == 32, "PID_BACKEND must decode to 32 bytes");
            raw
        }
        Err(_) => {
            println!("cargo:warning=PID_BACKEND unset — creation paths disabled (fail-closed zeros)");
            vec![0u8; 32]
        }
    };
    let lit = backend.iter().map(|b| b.to_string()).collect::<Vec<_>>().join(", ");
    std::fs::write(&out, format!("pub const BACKEND: [u8; 32] = [{}];\n", lit)).unwrap();
    println!("cargo:rerun-if-env-changed=PID_BACKEND");
}
