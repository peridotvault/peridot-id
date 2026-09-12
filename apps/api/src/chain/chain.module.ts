import { Module } from "@nestjs/common";
import { ChainRegistryService } from "./chain-registry.service";

@Module({
  providers: [ChainRegistryService],
  exports: [ChainRegistryService],
})
export class ChainModule {}
