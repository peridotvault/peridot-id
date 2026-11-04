# @peridotvault/pid-payments

PeridotID fiat-gateway primitives — DOKU (Jokul/SNAP) signature helpers, the
payment-method catalog, and the shared fiat view types. Pure functions: no
chain imports, no network calls, no environment lookups. Shared by the
PeridotID API and SDK.

## Install

```sh
pnpm add @peridotvault/pid-payments
```

## Usage

```ts
import {
  PAYMENT_METHODS,
  calcGatewayFee,
  parseIdrStrict,
  paymentMethodCategory,
} from "@peridotvault/pid-payments";

PAYMENT_METHODS.length; // 21 channels
paymentMethodCategory("EMONEY_OVO"); // "EWALLET"
parseIdrStrict("100000"); // 100000n
calcGatewayFee(100_000n, {
  percentBps: 70, // 0.7%
  flatIdr: 0n,
  minIdr: 100n,
  maxIdr: 0n, // 0 = no cap
}); // 700n
```

## What's inside

- `checkout` — DOKU Checkout payment + order-status signature helpers
  (`checkoutSignature`, `checkoutGetSignature`, `checkoutDigest`).
- `subaccount` — Sub-Account (SAC) registration/transfer/inquiry helpers.
- `payment-methods` — channel catalog, category mapping, gateway fee math.
- `money` — strict IDR parsing and decimal formatting (`bigint`, whole rupiah).

Payments on the PeridotID ledger (deposit, fee, transfer, balance) are
documented at <https://docs.peridot.id/fiat>.

MIT © Antigane Inc.
