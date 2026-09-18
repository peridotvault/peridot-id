import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DokuProvider } from "@peridotvault/pid-payments";
import { FiatController } from "./fiat.controller";
import { FiatService } from "./fiat.service";
import { PAYMENT_PROVIDER } from "./payment-provider.token";

@Module({
  controllers: [FiatController],
  providers: [
    // Single switch point for the fiat gateway: set PAYMENTS_PROVIDER and add
    // the provider class here. Everything downstream speaks PaymentProvider.
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const name = config.get<string>("PAYMENTS_PROVIDER", "doku");
        if (name !== "doku") throw new Error(`Unknown PAYMENTS_PROVIDER=${name}`);
        return new DokuProvider({
          mode: config.get<string>("DOKU_MODE", "sandbox") === "production" ? "production" : "sandbox",
          clientId: config.get<string>("DOKU_CLIENT_ID", ""),
          secretKey: config.get<string>("DOKU_SECRET_KEY", ""),
        });
      },
    },
    FiatService,
  ],
})
export class FiatModule {}
