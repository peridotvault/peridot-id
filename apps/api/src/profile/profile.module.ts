import { Module } from "@nestjs/common";
import { ExperienceModule } from "../experience/experience.module";
import { ProfileController } from "./profile.controller";
import { ProfileService } from "./profile.service";

@Module({
  imports: [ExperienceModule],
  controllers: [ProfileController],
  providers: [ProfileService],
})
export class ProfileModule {}
