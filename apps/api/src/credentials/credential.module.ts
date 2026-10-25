import { Module } from "@nestjs/common";
import { SecurityModule } from "../security/security-event.module";
import { RelayerModule } from "../relayer/relayer.module";
import { CredentialController } from "./credential.controller";
import { CredentialService } from "./credential.service";

@Module({
  imports: [SecurityModule, RelayerModule],
  controllers: [CredentialController],
  providers: [CredentialService],
  exports: [CredentialService],
})
export class CredentialModule {}
