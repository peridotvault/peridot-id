import { Injectable } from "@nestjs/common";
import { Profile } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  getMe(identityId: string): Promise<Profile> {
    return this.prisma.profile.findUniqueOrThrow({ where: { identityId } });
  }

  update(identityId: string, data: Partial<Pick<Profile, "displayName" | "avatarUrl" | "locale">>): Promise<Profile> {
    return this.prisma.profile.update({ where: { identityId }, data });
  }
}
