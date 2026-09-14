import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Identity } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class IdentityService {
  constructor(private readonly prisma: PrismaService) {}

  getMe(pid: string): Promise<Pick<Identity, "pid" | "status" | "role" | "createdAt">> {
    return this.prisma.identity.findUniqueOrThrow({
      where: { pid },
      select: { pid: true, status: true, role: true, createdAt: true },
    });
  }

  listCredentials(pid: string) {
    return this.prisma.identityCredential.findMany({
      where: { pid },
      select: { id: true, provider: true, email: true, linkedAt: true, lastLoginAt: true },
      orderBy: { linkedAt: "asc" },
    });
  }

  async unlinkCredential(pid: string, credentialId: string): Promise<void> {
    const credential = await this.prisma.identityCredential.findFirst({
      where: { id: credentialId, pid },
      select: { id: true },
    });
    if (!credential) throw new NotFoundException("Credential not found");

    const count = await this.prisma.identityCredential.count({ where: { pid } });
    if (count <= 1) throw new BadRequestException("Kamu butuh minimal satu credential untuk login");

    await this.prisma.identityCredential.delete({ where: { id: credentialId } });
  }

  /** Soft-delete the identity: revoke all sessions, mark deleted. Rows are retained. */
  async deleteAccount(pid: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.session.updateMany({
        where: { device: { pid } },
        data: { revokedAt: new Date() },
      });
      await tx.identity.update({
        where: { pid },
        data: { status: "deleted", deletedAt: new Date() },
      });
    });
  }
}
