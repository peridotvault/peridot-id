import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Profile } from "@prisma/client";
import { LevelsService, LevelView } from "../experience/levels.service";
import { PrismaService } from "../prisma/prisma.service";

export interface ProfileWithLevel extends Profile {
  /**
   * Authoritative level summary, read live from UserXpState (ANT-89 M1).
   * Apps must NOT persist this — no XP duplication in app DBs; re-read it.
   */
  level: LevelView;
}

@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly levels: LevelsService,
  ) {}

  async getMe(pid: string): Promise<ProfileWithLevel> {
    const profile = await this.prisma.profile.findUniqueOrThrow({ where: { pid } });
    const level = await this.levels.getLevelView(pid);
    return { ...profile, level };
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
