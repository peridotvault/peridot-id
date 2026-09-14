import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SecurityEventService {
  constructor(private readonly prisma: PrismaService) {}

  async log(pid: string, eventType: string, metadata: Record<string, unknown> = {}): Promise<void> {
    await this.prisma.securityEvent.create({
      data: {
        pid,
        eventType,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }
}