import { Injectable } from "@nestjs/common";
import { Identity } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class IdentityService {
  constructor(private readonly prisma: PrismaService) {}

  getMe(identityId: string): Promise<Pick<Identity, "id" | "createdAt">> {
    return this.prisma.identity.findUniqueOrThrow({ where: { id: identityId }, select: { id: true, createdAt: true } });
  }
}
