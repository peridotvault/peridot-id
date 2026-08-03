import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { Profile } from "@prisma/client";
import { CurrentUser, AuthenticatedUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import { ProfileService } from "./profile.service";

@Controller("v1/profile")
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Get("me")
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser): Promise<Profile> {
    return this.profileService.getMe(user.identityId);
  }

  @Patch()
  @UseGuards(JwtAuthGuard)
  update(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto): Promise<Profile> {
    return this.profileService.update(user.identityId, dto);
  }
}
