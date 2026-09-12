import { Module } from "@nestjs/common";
import { SecurityModule } from "../security/security-event.module";
import { ChainModule } from "../chain/chain.module";
import { AccountController } from "./account.controller";
import { AccountService } from "./account.service";
import { ActivationService } from "./activation.service";
import { EvmActivationService } from "./evm-activation.service";

@Module({
  imports: [SecurityModule, ChainModule],
  controllers: [AccountController],
  providers: [AccountService, ActivationService, EvmActivationService],
  exports: [ActivationService, EvmActivationService],
})
export class AccountModule {}