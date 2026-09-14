import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SecurityEventService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Audit write. Pass the interactive-transaction client when logging inside
   * `$transaction` — the root client runs on a separate connection where
   * uncommitted rows are invisible, so the FK check would reject the write
   * (P2003) and roll the whole transaction back.
   */
  async log(
    pid: string,
    eventType: string,
    metadata: Record<string, unknown> = {},
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    await (tx ?? this.prisma).securityEvent.create({
      data: {
        pid,
        eventType,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }
}