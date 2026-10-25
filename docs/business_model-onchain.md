# PeridotID — On-Chain Business Model

Board-approved on-chain business model (parent: ANT-543). This file is the
**source of truth for pricing** (referenced by ANT-542). Numbers below are
transcribed verbatim from the board-authored model — do not re-derive them.

> **Status note:** this document describes pricing **policy**. The chain-specific
> minimum fees below are policy/model, **NOT implemented** on-chain today.
> `contracts/WHITEPAPER.md` §1/§2 is the technical fee-schema spec
> (`protocolFee = floor(networkFee × 5000 bps / 10_000)`, no minimum floor
> on-chain). This doc MUST NOT be read as claiming contracts enforce the minimums.

## 1. Principle

Developers get started for free. Off-chain login and signatures are free within
reasonable fair-use limits. PeridotID revenue = paid on-chain transactions only.

## 2. Fee policy

PeridotID service fee = the GREATER of 50% of the network fee or the
chain-specific minimum fee. Total user cost = network fee + service fee,
displayed separately and transparently before approval.

## 3. Per-chain minimum-fee + revenue scenarios

| Blockchain | Minimum fee | Rev 1K MAU/mo | 10K | 100K | 1M |
|---|---|---|---|---|---|
| Stellar | 0.01 XLM | Rp272K | Rp2.72M | Rp27.2M | Rp272M |
| Solana | 0.000017 SOL | Rp275K | Rp2.75M | Rp27.47M | Rp274.72M |
| Ethereum | 0.00000075 ETH | Rp3.95M | Rp39.48M | Rp394.8M | Rp3.95B |
| Base | 0.00000075 ETH | Rp282K | Rp2.82M | Rp28.2M | Rp282M |
| BNB Smart Chain | 0.0000023 BNB | Rp274K | Rp2.74M | Rp27.42M | Rp274.16M |

Chain-status labels (vs `CHAIN_REGISTRY.md`, which seeds only `solana-devnet` +
`solana-testnet` rows): **Solana = live** (devnet/testnet registry rows exist);
**Stellar, Ethereum, Base, BNB Smart Chain = planned** pricing coverage. The
registry tracks live supported chains; this model covers pricing including
planned chains. This doc does NOT imply registry support for
Stellar/ETH/Base/BNB.

## 4. Assumptions

- 10 paid transactions / MAU / month.
- Rp16,000 / USD.
- Token prices: XLM $0.17, SOL $101, ETH $2,350, BNB $745.
- Revenue = gross platform fees, not profit.
- Do NOT sum across chains (same users may be multi-chain).
- Ethereum note: estimate uses network fee 0.000021 ETH (21,000 gas @ 1 gwei)
  → 50% markup 0.0000105 ETH exceeds the minimum; illustrative only, fees fluctuate.

## 5. Off-chain operating-cost estimates

Platform-wide, NOT per chain; rough, excluding salaries/audits/legal/tax:

| MAU | Est. monthly cost |
|---|---|
| 1K | Rp467K/mo |
| 10K | Rp2M/mo |
| 100K | Rp13M/mo |
| 1M | Rp120M/mo |

Baseline: Hostinger KVM 2 VPS Rp5M/year (~Rp417K/mo).

## 6. Per-chain worked examples

Each line: network fee → platform (service) fee → total user cost.

- Stellar: 0.00001 → 0.01 → 0.01001 XLM.
- Solana: 0.000005 → 0.000017 → 0.000022 SOL.
- Ethereum: 0.000021 → 0.0000105 → 0.0000315 ETH.
- Base: 0.0000002 → 0.00000075 → 0.00000095 ETH.
- BNB Smart Chain: 0.0000021 → 0.0000023 → 0.0000044 BNB.

## 7. Summary

- Free to start — off-chain login and signatures free within reasonable fair-use limits.
- Revenue from real transactions — 50% of the network fee subject to the chain minimum.
- Transparent pricing — network and service fees displayed separately; charged only after approval.
- Sustainable, not exploitative — minimums reviewed against token prices, volume, costs, and feedback.

## 8. Disclaimer

All figures are planning scenarios, not guarantees. Network fees and token
prices fluctuate; complex contract interactions may cost more than these
estimates. Chain minimums are reviewed against token prices, volume, costs,
and feedback.

## 9. Links

- Technical fee schema: `contracts/WHITEPAPER.md` §1/§2 (canonical contracts spec).
- Live chain support: `docs/CHAIN_REGISTRY.md` (server source of truth for chains).
- Parent: ANT-543 ("PeridotID — On-Chain Business Model"); pricing reference: ANT-542.
