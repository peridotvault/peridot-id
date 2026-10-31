//! PeridotID Stellar experiments + Phase-1 P1 cores (ANT-703).
//!
//! Experiment-only crate: pure-logic cores of the four testnet experiments.
//! No mainnet, no production data. OZ Smart Account deploy + on-chain parity
//! runs against Stellar testnet (see RUNBOOK.md); this crate pins the math so
//! the testnet runs assert against identical local vectors.
//!
//! Phase-1 P1 (testnet hard cutover — Phase-0 v1 vectors throwaway):
//! `auth` carries DOMAIN v2 + network binding (F1) and snapshot-bound u32
//! rule IDs (G2); `rules` carries the canonical scope encoding (T3);
//! `fees` carries the TTL-cron decision skeleton (TTL-cron + OQ-2, runbook
//! in TTL_CRON.md).
//!
//! Domain lenses applied: gas (u64 stroop math, no alloc), checks-effects
//! (cap checks before mutation in callers), least-privilege rule catalogue.

pub mod auth;
pub mod fees;
pub mod rules;
pub mod salt;
