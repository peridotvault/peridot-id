import { Module } from "@nestjs/common";
import { SecurityModule } from "../security/security-event.module";
import { ChainModule } from "../chain/chain.module";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";

@Module({
  imports: [SecurityModule, ChainModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
