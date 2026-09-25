import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DokuCheckoutClient, DokuSubAccountProvider } from "@peridotvault/pid-payments";
import { SecurityModule } from "../security/security-event.module";
import { CHECKOUT_CLIENT } from "./checkout-client.token";
import { FiatController } from "./fiat.controller";
import { FiatLedgerController } from "./fiat-ledger.controller";
import { FiatLedgerService } from "./fiat-ledger.service";
import { FiatSubAccountService } from "./fiat-subaccount.service";
import { SUBACCOUNT_PROVIDER } from "./subaccount-provider.token";

@Module({
  imports: [SecurityModule],
  controllers: [FiatController, FiatLedgerController],
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
  ],
})
export class FiatModule {}
