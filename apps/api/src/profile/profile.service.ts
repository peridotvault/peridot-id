import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Profile } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  getMe(pid: string): Promise<Profile> {
    return this.prisma.profile.findUniqueOrThrow({ where: { pid } });
  }

  // NOTE: the PID (`<handle>@pid`) is the immutable identity — it is the
  // Identity PK and has no update path. Only mutable labels live here.
  update(
    pid: string,
    data: Partial<Pick<Profile, "displayName" | "avatarUrl" | "locale">>,
  ): Promise<Profile> {
    const update: Prisma.ProfileUpdateInput = { ...data };
    return this.prisma.profile.update({ where: { pid }, data: update });
  }
}
