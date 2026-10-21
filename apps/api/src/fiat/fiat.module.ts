import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DokuCheckoutClient, DokuSubAccountProvider } from "@peridotvault/pid-payments";
import { SecurityModule } from "../security/security-event.module";
import { CHECKOUT_CLIENT } from "./checkout-client.token";
import { FaucetController } from "./faucet.controller";
import { FiatController } from "./fiat.controller";
import { FiatLedgerController } from "./fiat-ledger.controller";
import { FiatLedgerService } from "./fiat-ledger.service";
import { FiatSubAccountService } from "./fiat-subaccount.service";
import { PaymentFeeService } from "./payment-fee.service";
import { SUBACCOUNT_PROVIDER } from "./subaccount-provider.token";

/**
 * Faucet gate flag (ANT-290 contract, deploy/compose.yaml): the faucet route
 * is registered IFF `PID_FAUCET_ENABLED` is exactly `"true"`. Anything else
 * (unset, "false", any other string) ⇒ route absent ⇒ 404, zero ledger
 * writes. Fail-closed default: compose passes `false` unless the sandbox
 * deploy sets `true`. The controller + service re-check at runtime in case
 * the env changed after boot (defense in depth). Never gate on DOKU_MODE —
 * it defaults to sandbox and would fail open.
 */
const FAUCET_ENABLED = process.env.PID_FAUCET_ENABLED === "true";

@Module({
  imports: [SecurityModule],
  controllers: [FiatController, FiatLedgerController, ...(FAUCET_ENABLED ? [FaucetController] : [])],
  providers: [
    // DOKU Sub-Account provider — legacy surface kept for internal/admin
    // paths only; the user-facing money-in (Checkout) needs no sub-account.
    {
      provide: SUBACCOUNT_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        return new DokuSubAccountProvider({
          mode: config.get<string>("DOKU_MODE", "sandbox") === "production" ? "production" : "sandbox",
          clientId: config.get<string>("DOKU_CLIENT_ID", ""),
          secretKey: config.get<string>("DOKU_SECRET_KEY", ""),
          privateKey: config.get<string>("DOKU_PRIVATE_KEY", ""),
        });
      },
    },
    // DOKU Checkout (money-in) client. Same merchant credentials, non-SNAP
    // HMAC-SHA256 request signing. Missing keys fail at call time.
    {
      provide: CHECKOUT_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        return new DokuCheckoutClient({
          mode: config.get<string>("DOKU_MODE", "sandbox") === "production" ? "production" : "sandbox",
          clientId: config.get<string>("DOKU_CLIENT_ID", ""),
          secretKey: config.get<string>("DOKU_SECRET_KEY", ""),
        });
      },
    },
    FiatSubAccountService,
    FiatLedgerService,
    PaymentFeeService,
  ],
})
export class FiatModule {}
