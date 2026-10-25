import { Module } from "@nestjs/common";
import { SecurityModule } from "../security/security-event.module";
import { ChainModule } from "../chain/chain.module";
import { WasabiStorageService } from "../common/wasabi-storage";
import { RelayerModule } from "../relayer/relayer.module";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { ChainPreviewService } from "./chain-preview.service";
import { TokenPreviewService } from "./token-preview.service";

@Module({
  imports: [SecurityModule, ChainModule, RelayerModule],
  controllers: [AdminController],
  providers: [AdminService, ChainPreviewService, TokenPreviewService, WasabiStorageService],
})
export class AdminModule {}
