import { Module } from "@nestjs/common";
import { SecurityModule } from "../security/security-event.module";
import { AccountController } from "./account.controller";
import { AccountService } from "./account.service";
import { ActivationService } from "./activation.service";

@Module({
  imports: [SecurityModule],
  controllers: [AccountController],
  providers: [AccountService, ActivationService],
  exports: [ActivationService],
})
export class AccountModule {}