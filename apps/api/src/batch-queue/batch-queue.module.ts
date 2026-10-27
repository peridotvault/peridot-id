import { Module } from "@nestjs/common";
import { SecurityModule } from "../security/security-event.module";
import { ChainModule } from "../chain/chain.module";
import { FeeModule } from "../fee/fee.module";
import { BatchQueueController } from "./batch-queue.controller";
import { BatchQueueService } from "./batch-queue.service";

@Module({
  imports: [SecurityModule, ChainModule, FeeModule],
  controllers: [BatchQueueController],
  providers: [BatchQueueService],
  exports: [BatchQueueService],
})
export class BatchQueueModule {}
