import { Module } from "@nestjs/common";
import { SessionKeysController } from "./session-keys.controller";
import { SessionKeysService } from "./session-keys.service";

@Module({
  controllers: [SessionKeysController],
  providers: [SessionKeysService],
  exports: [SessionKeysService],
})
export class SessionKeysModule {}
