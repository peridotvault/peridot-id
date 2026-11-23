import { Global, Inject, Module, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaService, createPrismaClient } from "./prisma.service";

@Global()
@Module({
  providers: [{ provide: PrismaService, useFactory: createPrismaClient }],
  exports: [PrismaService],
})
export class PrismaModule implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  // Lifecycle lives here because the DI instance is an extended client, not a
  // constructed PrismaService subclass.
  async onModuleInit(): Promise<void> {
    await this.prisma.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
