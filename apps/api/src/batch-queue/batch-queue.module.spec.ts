// Module-wiring regression spec (ANT-766 QA blocker): BatchQueueModule must
// boot under Nest DI. The interface-typed 5th ctor param previously emitted
// an `Object` provider token, crashing app startup with
// UnknownDependenciesException while unit specs (manual `new`) stayed green.
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import { ChainRegistryService } from "../chain/chain-registry.service";
import { TokenRegistryService } from "../chain/token-registry.service";
import { WasabiStorageService } from "../common/wasabi-storage";
import { FeePolicyService } from "../fee/fee-policy.service";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import { BatchQueueController } from "./batch-queue.controller";
import { BATCH_PORTS, BatchQueueService } from "./batch-queue.service";
import { BatchQueueModule } from "./batch-queue.module";

describe("BatchQueueModule wiring (ANT-766 blocker)", () => {
  it("resolves the controller and service under Nest DI", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ name: "default", ttl: 60000, limit: 100 }]), BatchQueueModule],
    })
      .overrideProvider(ChainRegistryService)
      .useValue({ selectionFromReferenceOrThrow: jest.fn() })
      .overrideProvider(FeePolicyService)
      .useValue({
        activePolicy: jest.fn(async () => ({ version: 2, bps: 5000 })),
        recordSubsidy: jest.fn(),
      })
      .overrideProvider(SecurityEventService)
      .useValue({ log: jest.fn() })
      .useMocker((token) => {
        if (token === PrismaService) return { queuedBatch: {} };
        if (token === ConfigService) return { get: jest.fn() };
        if (token === TokenRegistryService) return {};
        if (token === WasabiStorageService) return {};
      })
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    expect(moduleRef.get(BatchQueueService)).toBeDefined();
    expect(moduleRef.get(BatchQueueController)).toBeDefined();
    // The ports binding is the production factory (provisioned per call —
    // unset relayer/registry rows fail closed); it must resolve under DI.
    expect(moduleRef.get(BATCH_PORTS)).toBeDefined();
    await app.close();
  });
});
