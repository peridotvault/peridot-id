import { Module } from "@nestjs/common";
import { SecurityModule } from "../security/security-event.module";
import { ChainModule } from "../chain/chain.module";
import { AccountController } from "./account.controller";
import { AccountService } from "./account.service";
import { ActivationService } from "./activation.service";
import { EvmActivationService } from "./evm-activation.service";
import { RelayerModule } from "../relayer/relayer.module";

@Module({
  imports: [SecurityModule, ChainModule, RelayerModule],
  controllers: [AccountController],
  providers: [AccountService, ActivationService, EvmActivationService],
  exports: [ActivationService, EvmActivationService],
})
export class AccountModule {}