import { Module } from "@nestjs/common";
import { WasabiStorageService } from "../common/wasabi-storage";
import { ChainController } from "./chain.controller";
import { ChainRegistryService } from "./chain-registry.service";
import { TokenController } from "./token.controller";
import { TokenRegistryService } from "./token-registry.service";

@Module({
  controllers: [ChainController, TokenController],
  providers: [ChainRegistryService, TokenRegistryService, WasabiStorageService],
  exports: [ChainRegistryService, TokenRegistryService],
})
export class ChainModule {}
