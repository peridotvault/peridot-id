import { Module } from "@nestjs/common";
import { ChainModule } from "../chain/chain.module";
import { SecurityModule } from "../security/security-event.module";
import { IntentController } from "./intent.controller";
import { IntentService } from "./intent.service";

@Module({
  imports: [SecurityModule, ChainModule],
  controllers: [IntentController],
  providers: [IntentService],
})
export class IntentModule {}