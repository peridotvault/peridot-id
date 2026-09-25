import { Module } from "@nestjs/common";
import { ChainController } from "./chain.controller";
import { ChainRegistryService } from "./chain-registry.service";

@Module({
  controllers: [ChainController],
  providers: [ChainRegistryService],
  exports: [ChainRegistryService],
})
export class ChainModule {}
