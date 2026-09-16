import { Module } from "@nestjs/common";
import { SecurityModule } from "../security/security-event.module";
import { ChainModule } from "../chain/chain.module";
import { WalletController } from "./wallet.controller";
import { RotateService } from "./rotate.service";
import { SponsoredWithdrawService } from "./sponsored-withdraw.service";
import { WalletService } from "./wallet.service";

@Module({
  imports: [SecurityModule, ChainModule],
  controllers: [WalletController],
  providers: [WalletService, SponsoredWithdrawService, RotateService],
})
export class WalletModule {}
