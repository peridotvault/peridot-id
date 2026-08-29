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
import { AccountController } from "./account.controller";
import { AccountService } from "./account.service";

const SECRET = "authz-test-access-secret-0123456789abcdef";
const PROGRAM_ID = "9LCZEdXdmLeEyU8Fik2721R28K4xWXTrVd76r4tczNZY";

function token(sub: string, extra: Record<string, unknown> = {}) {
  return new JwtService({}).signAsync({ sub, type: "access", ...extra }, { secret: SECRET });
}

describe("Account authorization & abuse cases (routes)", () => {
  let app: INestApplication;
  let storage: ThrottlerStorage;
  let state: { identities: Map<string, string>; accounts: Map<string, { id: string; identityId: string }> };

  beforeAll(async () => {
    state = { identities: new Map(), accounts: new Map() };
    const prisma = {
      identity: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
          const status = state.identities.get(where.id);
          return status ? { status } : null;
        }),
      },
      pidAccount: {
        findFirst: jest.fn(async ({ where, include }: { where: { id?: string; identityId: string; status?: string }; include?: { chainAccounts: object } }) => {
          const row = [...state.accounts.values()].find((a) => a.identityId === where.identityId && (!where.id || a.id === where.id));
          if (!row) return null;
          return {
            ...row,
            status: "active",
            version: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ...(include ? { chainAccounts: [{ id: `chain-${row.id}`, accountId: row.id, chainNamespace: "solana", chainReference: "ref", address: `addr-${row.id}`, accountType: "smart_account", status: "active", createdAt: new Date().toISOString() }] } : {}),
          };
        }),
        findMany: jest.fn(async () => []),
        create: jest.fn(async ({ data }: { data: { identityId: string } }) => {
          const row = { id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", identityId: data.identityId };
          state.accounts.set(row.id, row);
          return { ...row, status: "active", version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        }),
      },
      chainAccount: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async () => ({
          id: "chain-x",
          accountId: "acc-x",
          chainNamespace: "solana",
          chainReference: "ref",
          address: "addr-x",
          accountType: "smart_account",
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })),
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
    state.accounts.clear();
    (storage as unknown as { storage: Map<unknown, unknown> }).storage.clear();
  });

  it("rejects a request with no access cookie", async () => {
    await request(app.getHttpServer()).get("/v1/accounts").expect(401);
  });

  it("rejects a token for an unknown PID", async () => {
    const t = await token("pid_does_not_exist");
    await request(app.getHttpServer()).get("/v1/accounts").set("Cookie", `pid_access=${t}`).expect(401);
  });

  it("creates the default account with a smart_account chain account", async () => {
    state.identities.set("pid_a", "active");
    const t = await token("pid_a");

    const res = await request(app.getHttpServer()).post("/v1/accounts").set("Cookie", `pid_access=${t}`).expect(200);

    expect(res.body.id).toBe("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11");
    expect(res.body.chainAccounts).toHaveLength(1);
    expect(res.body.chainAccounts[0].accountType).toBe("smart_account");
    expect(res.body).not.toHaveProperty("identityId");
  });

  it("GET /v1/accounts/:id never returns another PID's account (no IDOR)", async () => {
    state.identities.set("pid_a", "active");
    state.identities.set("pid_b", "active");
    state.accounts.set("11111111-1111-4111-8111-111111111111", { id: "11111111-1111-4111-8111-111111111111", identityId: "pid_a" });
    const tB = await token("pid_b");

    await request(app.getHttpServer()).get("/v1/accounts/11111111-1111-4111-8111-111111111111").set("Cookie", `pid_access=${tB}`).expect(404);
  });

  it("returns 404 for an unknown account id", async () => {
    state.identities.set("pid_a", "active");
    const t = await token("pid_a");

    await request(app.getHttpServer()).get("/v1/accounts/11111111-1111-4111-8111-111111111111").set("Cookie", `pid_access=${t}`).expect(404);
  });

  it("rejects a malformed account id with 400", async () => {
    state.identities.set("pid_a", "active");
    const t = await token("pid_a");

    await request(app.getHttpServer()).get("/v1/accounts/not-a-uuid").set("Cookie", `pid_access=${t}`).expect(400);
  });

  it("GET /v1/accounts/:id/chains is ownership-checked too", async () => {
    state.identities.set("pid_b", "active");
    state.accounts.set("11111111-1111-4111-8111-111111111111", { id: "11111111-1111-4111-8111-111111111111", identityId: "pid_a" });
    const tB = await token("pid_b");

    await request(app.getHttpServer()).get("/v1/accounts/11111111-1111-4111-8111-111111111111/chains").set("Cookie", `pid_access=${tB}`).expect(404);
  });
});