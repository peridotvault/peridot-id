import { ConflictException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Profile } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  getMe(identityId: string): Promise<Profile> {
    return this.prisma.profile.findUniqueOrThrow({ where: { identityId } });
  }

  async update(
    identityId: string,
    data: { username?: string } & Partial<Pick<Profile, "displayName" | "avatarUrl" | "locale">>,
  ): Promise<Profile> {
    const update: Prisma.ProfileUpdateInput = { ...data };
    if (data.username !== undefined) {
      const current = await this.prisma.profile.findUniqueOrThrow({ where: { identityId } });
      update.username = data.username.toLowerCase();
      if (current.username !== update.username) update.usernameChangedAt = new Date();
    }
    try {
      return await this.prisma.profile.update({ where: { identityId }, data: update });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ConflictException("username sudah dipakai");
      }
      throw err;
    }
  }
}
