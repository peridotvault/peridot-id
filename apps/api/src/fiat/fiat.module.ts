import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DokuCheckoutClient, DokuSubAccountProvider } from "@peridotvault/pid-payments";
import { SecurityModule } from "../security/security-event.module";
import { CHECKOUT_CLIENT } from "./checkout-client.token";
import { FiatSubAccountController } from "./fiat-subaccount.controller";
import { FiatSubAccountService } from "./fiat-subaccount.service";
import { SUBACCOUNT_PROVIDER } from "./subaccount-provider.token";

@Module({
  imports: [SecurityModule],
  controllers: [FiatSubAccountController],
  providers: [
    // DOKU Sub-Account V2 provider. Reuses the DOKU merchant credentials;
    // the RSA key signs B2B token requests. Missing keys fail at call time
    // with a clear error so non-fiat setups still boot.
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
  ],
})
export class FiatModule {}
