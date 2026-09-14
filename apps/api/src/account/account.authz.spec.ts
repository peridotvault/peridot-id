import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { ThrottlerModule, ThrottlerStorage } from "@nestjs/throttler";
import cookieParser from "cookie-parser";
import request from "supertest";
import { JwtStrategy } from "../auth/jwt.strategy";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import { ActivationService } from "./activation.service";
import { AccountController } from "./account.controller";
import { AccountService } from "./account.service";
import { ChainRegistryService } from "../chain/chain-registry.service";
import { EvmActivationService } from "./evm-activation.service";

const SECRET = "authz-test-access-secret-0123456789abcdef";
const PROGRAM_ID = "9LCZEdXdmLeEyU8Fik2721R28K4xWXTrVd76r4tczNZY";

function token(sub: string, extra: Record<string, unknown> = {}) {
  return new JwtService({}).signAsync({ sub, type: "access", ...extra }, { secret: SECRET });
}

describe("Account authorization & abuse cases (routes)", () => {
  let app: INestApplication;
  let storage: ThrottlerStorage;
  let state: { identities: Map<string, string>; chains: Map<string, Record<string, unknown>> };

  beforeAll(async () => {
    state = { identities: new Map(), chains: new Map() };
    const prisma = {
      identity: {
        findUnique: jest.fn(async ({ where }: { where: { pid: string } }) => {
          const status = state.identities.get(where.pid);
          return status ? { status } : null;
        }),
      },
      chainAccount: {
        findFirst: jest.fn(async ({ where }: { where: { pid: string } }) => {
          const rows = [...state.chains.values()].filter((r) => r.pid === where.pid);
          return (rows[0] as Record<string, unknown> | undefined) ?? null;
        }),
        findMany: jest.fn(async ({ where }: { where: { pid: string } }) =>
          [...state.chains.values()].filter((r) => r.pid === where.pid),
        ),
        create: jest.fn(async ({ data }: { data: { pid: string } }) => {
          const row = {
            id: `chain-${data.pid}`,
            pid: data.pid,
            chainId: "chain-sol",
            chain: { namespace: "solana", reference: "ref" },
            address: `addr-${data.pid}`,
            accountType: "smart_account",
            status: "active",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          state.chains.set(row.id, row);
          return row;
        }),
      },
      chain: {
        findUnique: jest.fn(async () => ({ id: "chain-sol" })),
      },
      securityEvent: { create: jest.fn(async () => ({})) },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ name: "default", ttl: 60000, limit: 100 }])],
      controllers: [AccountController],
      providers: [
        AccountService,
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
            getOrThrow: jest.fn((key: string) => (key === "PID_PROGRAM_ID" ? PROGRAM_ID : SECRET)),
          },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: SecurityEventService, useValue: { log: jest.fn(async () => undefined) } },
        {
          provide: ChainRegistryService,
          useValue: {
            activeChains: jest.fn(async () => []),
            deployableEvmChains: jest.fn(async () => []),
            deploymentFor: jest.fn(async () => null),
            chainByReference: jest.fn(async () => undefined),
            rpcUrlForReference: jest.fn(async () => "http://localhost:8545"),
            solanaChainIdOrThrow: jest.fn(async () => "chain-sol"),
            invalidate: jest.fn(),
          },
        },
        { provide: ActivationService, useValue: { activate: jest.fn(), viewOf: jest.fn(), poll: jest.fn() } },
        { provide: EvmActivationService, useValue: { activate: jest.fn(), viewOf: jest.fn(), poll: jest.fn() } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    storage = app.get(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    state.identities.clear();
    state.chains.clear();
    (storage as unknown as { storage: Map<unknown, unknown> }).storage.clear();
  });

  it("rejects a request with no access cookie", async () => {
    await request(app.getHttpServer()).get("/v1/account").expect(401);
  });

  it("rejects a token for an unknown PID", async () => {
    const t = await token("pid_does_not_exist");
    await request(app.getHttpServer()).get("/v1/account").set("Cookie", `pid_access=${t}`).expect(401);
  });

  it("creates the wallet with a smart_account chain row", async () => {
    state.identities.set("pid_a", "active");
    const t = await token("pid_a");

    const res = await request(app.getHttpServer()).post("/v1/account").set("Cookie", `pid_access=${t}`).expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].accountType).toBe("smart_account");
    expect(res.body[0]).not.toHaveProperty("pid");
  });

  it("never returns another PID's wallet (isolation by construction — no ids in routes)", async () => {
    state.identities.set("pid_a", "active");
    state.identities.set("pid_b", "active");
    const tA = await token("pid_a");
    const tB = await token("pid_b");

    await request(app.getHttpServer()).post("/v1/account").set("Cookie", `pid_access=${tA}`).expect(200);

    await request(app.getHttpServer()).get("/v1/account").set("Cookie", `pid_access=${tB}`).expect(404);
    const resA = await request(app.getHttpServer()).get("/v1/account").set("Cookie", `pid_access=${tA}`).expect(200);
    expect(resA.body).toHaveLength(1);
  });

  it("returns 404 when the PID has no wallet yet", async () => {
    state.identities.set("pid_a", "active");
    const t = await token("pid_a");

    await request(app.getHttpServer()).get("/v1/account").set("Cookie", `pid_access=${t}`).expect(404);
  });

  it("GET /v1/account/chains is scoped to the caller too", async () => {
    state.identities.set("pid_b", "active");
    const tB = await token("pid_b");

    await request(app.getHttpServer()).get("/v1/account/chains").set("Cookie", `pid_access=${tB}`).expect(404);
  });
});