//! PeridotID Stellar Phase-0 experiments (ANT-551, handoff from ANT-546 §6).
//!
//! Experiment-only crate: pure-logic cores of the four testnet experiments.
//! No mainnet, no production data. OZ Smart Account deploy + on-chain parity
//! runs against Stellar testnet (see RUNBOOK.md); this crate pins the math so
//! the testnet runs assert against identical local vectors.
//!
//! Domain lenses applied: gas (u64 stroop math, no alloc), checks-effects
//! (cap checks before mutation in callers), least-privilege rule catalogue.

pub mod auth;
pub mod fees;
pub mod rules;
pub mod salt;
