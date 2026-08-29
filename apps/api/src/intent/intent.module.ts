import { Module } from "@nestjs/common";
import { SecurityModule } from "../security/security-event.module";
import { IntentController } from "./intent.controller";
import { IntentService } from "./intent.service";

@Module({
  imports: [SecurityModule],
  controllers: [IntentController],
  providers: [IntentService],
})
export class IntentModule {}