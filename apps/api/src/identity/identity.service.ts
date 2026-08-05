import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Identity } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class IdentityService {
  constructor(private readonly prisma: PrismaService) {}

  getMe(identityId: string): Promise<Pick<Identity, "id" | "status" | "createdAt">> {
    return this.prisma.identity.findUniqueOrThrow({
      where: { id: identityId },
      select: { id: true, status: true, createdAt: true },
    });
  }

  listCredentials(identityId: string) {
    return this.prisma.identityCredential.findMany({
      where: { identityId },
      select: { id: true, provider: true, email: true, linkedAt: true, lastLoginAt: true },
      orderBy: { linkedAt: "asc" },
    });
  }

  async unlinkCredential(identityId: string, credentialId: string): Promise<void> {
    const credential = await this.prisma.identityCredential.findFirst({
      where: { id: credentialId, identityId },
      select: { id: true },
    });
    if (!credential) throw new NotFoundException("Credential tidak ditemukan");

    const count = await this.prisma.identityCredential.count({ where: { identityId } });
    if (count <= 1) throw new BadRequestException("Kamu butuh minimal satu credential untuk login");

    await this.prisma.identityCredential.delete({ where: { id: credentialId } });
  }
}
