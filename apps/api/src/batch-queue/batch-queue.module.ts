import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SecurityModule } from "../security/security-event.module";
import { ChainModule } from "../chain/chain.module";
import { ChainRegistryService } from "../chain/chain-registry.service";
import { FeeModule } from "../fee/fee.module";
import { BatchQueueController } from "./batch-queue.controller";
import { BATCH_PORTS, BatchQueueService } from "./batch-queue.service";
import { productionBatchPorts } from "./batch-queue.transport";

@Module({
  imports: [SecurityModule, ChainModule, FeeModule],
  controllers: [BatchQueueController],
  providers: [
    BatchQueueService,
    // Production transport (ANT-767 scope expansion): real estimator /
    // submitter / simulator / sessions over the chain registry + relayer
    // key. Unset rows fail closed per call (503) — no silent behavior
    // change until the operator provisions them (see Trevor's ANT-771).
    {
      provide: BATCH_PORTS,
      useFactory: (chains: ChainRegistryService, config: ConfigService) => productionBatchPorts(chains, config),
      inject: [ChainRegistryService, ConfigService],
    },
  ],
  exports: [BatchQueueService],
})
export class BatchQueueModule {}
