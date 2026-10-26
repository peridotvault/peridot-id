//! Build script: bakes the program ID and backend allowlist into the program.
//!
//! `PID_PROGRAM_ID` (base58, this program's on-chain address for the target
//! cluster) becomes `program_id::ID` (ANT-211: previously a hardcoded
//! `declare_id!`). It defaults to the local/devnet address
//! `CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT`; testnet builds set
//! `D6TpM7caN3tG31Trq6cffKKnWbS4pP7nWJJbd2ALVsg3`. For named clusters the
//! default is forbidden: `PID_PROGRAM_ID_REQUIRED=1` (or
//! `SOLANA_CLUSTER=testnet*/mainnet*`) makes an unset `PID_PROGRAM_ID` a
//! build-time hard error instead of a silent fallback (ANT-215, Tobias
//! ANT-212 Finding 3). PDA derivation
//! (`state::verify_pda`, `treasury::verify_*_pda`) uses the runtime
//! `program_id`, so the gate ID and derivation cannot split-brain within one
//! binary, and rebuilding for the same address preserves existing accounts.
//! (A *new* address means new PDAs — PDAs are bound to (seeds, program id) —
//! so always build with the `PID_PROGRAM_ID` of the cluster you deploy to.)
//!
//! `PID_BACKEND` (base58, the Peridot relayer pubkey for this environment)
//! becomes `config::BACKEND`. Creation paths (`initialize`, `activate`) require
//! the payer/relayer to equal it — this is what binds a PID to a real user
//! (only the backend knows the pid↔identity mapping), so a stranger can neither
//! squat a PDA nor divert a pre-funded deposit.
//!
//! ANT-635 (ANT-638): `PID_TREASURY` / `config::TREASURY` are REMOVED. The
//! protocol-fee recipient is the program-bound PDA vault `[b"treasury"]`
//! (`treasury.rs`), derived at runtime per program id — no build-time const,
//! no env var. Any lingering `config::TREASURY` reference is a build break by
//! design. Neither constant enters PDA derivation: builds are env-specific by
//! design (program id per cluster via `PID_PROGRAM_ID`, backend const per
//! cluster). Local tests no longer set `PID_TREASURY`.
//!
//! Unset `PID_BACKEND` fails closed to `[0u8; 32]` (no caller matches — creation
//! disabled).

use std::path::PathBuf;

const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

fn decode_base58(s: &str, what: &str) -> Vec<u8> {
    let mut num: Vec<u32> = vec![0];
    for c in s.bytes() {
        let mut carry = ALPHABET
            .iter()
            .position(|&a| a == c)
            .unwrap_or_else(|| panic!("{what} must be base58"))
            as u32;
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
            let raw = decode_base58(s.trim(), what);
            assert!(raw.len() == 32, "{what} must decode to 32 bytes");
            Some(raw)
        }
        Err(_) => None,
    }
}

/// Default program ID for local/devnet builds (ANT-211: was `declare_id!`).
const DEFAULT_PROGRAM_ID: &str = "CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT";

fn main() {
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("config.rs");
    let backend = match parse_pubkey("PID_BACKEND", "PID_BACKEND") {
        Some(raw) => raw,
        None => {
            println!("cargo:warning=PID_BACKEND unset — creation paths disabled (fail-closed zeros)");
            vec![0u8; 32]
        }
    };
    let backend_lit = backend.iter().map(|b| b.to_string()).collect::<Vec<_>>().join(", ");
    std::fs::write(&out, format!("pub const BACKEND: [u8; 32] = [{backend_lit}];\n"))
        .unwrap();
    println!("cargo:rerun-if-env-changed=PID_BACKEND");
    // ANT-635: PID_TREASURY deleted — the vault is the runtime-derived
    // ["treasury"] PDA. A stale PID_TREASURY in the env is ignored loudly so
    // operators notice the migration instead of assuming it still binds.
    if std::env::var("PID_TREASURY").is_ok() {
        println!("cargo:warning=PID_TREASURY is obsolete (ANT-635 vault is the [b\"treasury\"] PDA) — ignoring");
    }

    // ANT-211: the program ID is build-configurable so a clean-source checkout
    // can target any cluster. `PID_PROGRAM_ID` unset keeps the local/devnet
    // default; testnet builds set the testnet address.
    //
    // ANT-215 (Tobias ANT-212 Finding 3): an unset `PID_PROGRAM_ID` silently
    // falling back to the default is what bricks testnet builds at runtime.
    // Deploy jobs for named clusters must fail closed here instead — signal
    // with either `PID_PROGRAM_ID_REQUIRED=1` or `SOLANA_CLUSTER=testnet*` /
    // `mainnet*`. Local/devnet builds (neither set) keep the default.
    let require_explicit = std::env::var("PID_PROGRAM_ID_REQUIRED")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
        || matches!(
            std::env::var("SOLANA_CLUSTER").unwrap_or_default().as_str(),
            "testnet" | "testnet-beta" | "mainnet" | "mainnet-beta"
        );
    let program_id_src = std::env::var("PID_PROGRAM_ID").unwrap_or_else(|_| {
        if require_explicit {
            panic!(
                "PID_PROGRAM_ID must be set explicitly for this cluster \
                 (PID_PROGRAM_ID_REQUIRED=1 / SOLANA_CLUSTER={:?}); refusing \
                 the local/devnet default {DEFAULT_PROGRAM_ID}",
                std::env::var("SOLANA_CLUSTER").unwrap_or_default()
            );
        }
        println!("cargo:warning=PID_PROGRAM_ID unset — using local/devnet default {DEFAULT_PROGRAM_ID}");
        DEFAULT_PROGRAM_ID.to_string()
    });
    let program_id = decode_base58(program_id_src.trim(), "PID_PROGRAM_ID");
    assert!(
        program_id.len() == 32,
        "PID_PROGRAM_ID must decode to 32 bytes"
    );
    let id_lit = program_id
        .iter()
        .map(|b| b.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    // Same shape as `declare_id!` (`ID`, `id()`, `check_id`) so `crate::ID`
    // users keep working; `new_from_array` is `const`, valid on SBF too
    // (unlike `from_str_const`, which needs a string literal).
    std::fs::write(
        PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("program_id.rs"),
        format!(
            "pub const ID: pinocchio::Address = pinocchio::Address::new_from_array([{id_lit}]);\n\
             pub const fn id() -> pinocchio::Address {{ ID }}\n\
             pub fn check_id(id: &pinocchio::Address) -> bool {{ id == &ID }}\n",
        ),
    )
    .unwrap();
    println!("cargo:warning=PID_PROGRAM_ID baked: {}", program_id_src.trim());
    println!("cargo:rerun-if-env-changed=PID_PROGRAM_ID");
    println!("cargo:rerun-if-env-changed=PID_PROGRAM_ID_REQUIRED");
    println!("cargo:rerun-if-env-changed=SOLANA_CLUSTER");
}
