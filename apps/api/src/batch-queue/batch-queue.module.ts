import { Module } from "@nestjs/common";
import { SecurityModule } from "../security/security-event.module";
import { ChainModule } from "../chain/chain.module";
import { FeeModule } from "../fee/fee.module";
import { BatchQueueController } from "./batch-queue.controller";
import { BATCH_PORTS, BatchQueueService, failClosedPorts } from "./batch-queue.service";

@Module({
  imports: [SecurityModule, ChainModule, FeeModule],
  controllers: [BatchQueueController],
  providers: [
    BatchQueueService,
    // Fail-closed default: every transport call 503s until a production
    // BatchPorts binding (estimator/submitter/simulator/sessions) is
    // provided — e.g. by the relayer transport wiring (see ANT-767).
    { provide: BATCH_PORTS, useFactory: () => failClosedPorts() },
  ],
  exports: [BatchQueueService],
})
export class BatchQueueModule {}
