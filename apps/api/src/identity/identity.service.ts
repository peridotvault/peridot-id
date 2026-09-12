import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Identity } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class IdentityService {
  constructor(private readonly prisma: PrismaService) {}

  getMe(identityId: string): Promise<Pick<Identity, "id" | "status" | "role" | "createdAt">> {
    return this.prisma.identity.findUniqueOrThrow({
      where: { id: identityId },
      select: { id: true, status: true, role: true, createdAt: true },
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
    if (!credential) throw new NotFoundException("Credential not found");

    const count = await this.prisma.identityCredential.count({ where: { identityId } });
    if (count <= 1) throw new BadRequestException("Kamu butuh minimal satu credential untuk login");

    await this.prisma.identityCredential.delete({ where: { id: credentialId } });
  }

  /** Soft-delete the identity: revoke all sessions, mark deleted. Rows are retained. */
  async deleteAccount(identityId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.session.updateMany({
        where: { device: { identityId } },
        data: { revokedAt: new Date() },
      });
      await tx.identity.update({
        where: { id: identityId },
        data: { status: "deleted", deletedAt: new Date() },
      });
    });
  }
}
