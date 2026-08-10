import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { ThrottlerModule, ThrottlerStorage } from "@nestjs/throttler";
import cookieParser from "cookie-parser";
import request from "supertest";
import { JwtStrategy } from "../auth/jwt.strategy";
import { PrismaService } from "../prisma/prisma.service";
import { WalletController } from "./wallet.controller";
import { WalletService } from "./wallet.service";

const SECRET = "authz-test-access-secret-0123456789abcdef";
const PUBLIC_FIELDS = ["id", "chain", "address", "status", "createdAt"];

type WalletRow = Record<string, unknown> & { address: string };

function pick<T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>): T {
  if (!select) return row;
  return Object.fromEntries(Object.entries(select).map(([k, v]) => [k, v ? row[k] : undefined])) as T;
}

describe("Wallet authorization & abuse cases (routes)", () => {
  let app: INestApplication;
  let storage: ThrottlerStorage;
  let state: { identities: Map<string, string>; wallets: Map<string, WalletRow> };

  const token = (sub: string, extra: Record<string, unknown> = {}) =>
    new JwtService({}).signAsync({ sub, type: "access", ...extra }, { secret: SECRET });

  beforeAll(async () => {
    state = { identities: new Map(), wallets: new Map() };
    const prisma = {
      identity: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
          const status = state.identities.get(where.id);
          return status ? { status } : null;
        }),
      },
      wallet: {
        findUnique: jest.fn(async ({ where, select }: { where: { identityId: string }; select?: Record<string, boolean> }) => {
          const row = state.wallets.get(where.identityId);
          return row ? pick(row, select) : null;
        }),
        create: jest.fn(
          async ({ data, select }: { data: { identityId: string; chain: string; address: string }; select: Record<string, boolean> }) => {
            const row: WalletRow = {
              id: `w-${state.wallets.size + 1}`,
              identityId: data.identityId,
              chain: data.chain,
              address: data.address,
              status: "active",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            state.wallets.set(data.identityId, row);
            return pick(row, select);
          },
        ),
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ name: "default", ttl: 60000, limit: 100 }])],
      controllers: [WalletController],
      providers: [
        WalletService,
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: { get: jest.fn(), getOrThrow: jest.fn(() => SECRET) },
        },
        { provide: PrismaService, useValue: prisma },
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
    state.wallets.clear();
    (storage as unknown as { storage: Map<unknown, unknown> }).storage.clear();
  });

  it("rejects a request with no access cookie", async () => {
    await request(app.getHttpServer()).get("/v1/wallet/me").expect(401);
  });

  it("rejects a forged access token", async () => {
    await request(app.getHttpServer())
      .get("/v1/wallet/me")
      .set("Cookie", "peridot_access=forged.token.value")
      .expect(401);
  });

  it("rejects an expired access token", async () => {
    state.identities.set("pid_a", "active");
    const t = await token("pid_a", { exp: Math.floor(Date.now() / 1000) - 60 });
    await request(app.getHttpServer()).get("/v1/wallet/me").set("Cookie", `peridot_access=${t}`).expect(401);
  });

  it("rejects a refresh-typed token on wallet routes", async () => {
    state.identities.set("pid_a", "active");
    const t = await new JwtService({}).signAsync({ sub: "pid_a", type: "refresh" }, { secret: SECRET });
    await request(app.getHttpServer()).get("/v1/wallet/me").set("Cookie", `peridot_access=${t}`).expect(401);
  });

  it("rejects a token for a suspended PID", async () => {
    state.identities.set("pid_a", "suspended");
    const t = await token("pid_a");
    await request(app.getHttpServer()).get("/v1/wallet/me").set("Cookie", `peridot_access=${t}`).expect(401);
  });

  it("rejects a token for a deleted PID", async () => {
    state.identities.set("pid_a", "deleted");
    const t = await token("pid_a");
    await request(app.getHttpServer()).get("/v1/wallet/me").set("Cookie", `peridot_access=${t}`).expect(401);
  });

  it("rejects a token for an unknown PID", async () => {
    const t = await token("pid_does_not_exist");
    await request(app.getHttpServer()).get("/v1/wallet/me").set("Cookie", `peridot_access=${t}`).expect(401);
  });

  it("returns 404 for a valid token with no wallet", async () => {
    state.identities.set("pid_a", "active");
    const t = await token("pid_a");
    await request(app.getHttpServer()).get("/v1/wallet/me").set("Cookie", `peridot_access=${t}`).expect(404);
  });

  it("returns only public wallet fields for the authenticated PID", async () => {
    state.identities.set("pid_a", "active");
    state.wallets.set("pid_a", {
      id: "w1",
      identityId: "pid_a",
      chain: "solana",
      address: "addr-1",
      status: "active",
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
    });
    const t = await token("pid_a");

    const res = await request(app.getHttpServer()).get("/v1/wallet/me").set("Cookie", `peridot_access=${t}`).expect(200);

    expect(Object.keys(res.body).sort()).toEqual([...PUBLIC_FIELDS].sort());
    expect(res.body).toEqual({ id: "w1", chain: "solana", address: "addr-1", status: "active", createdAt: "2026-08-10T12:00:00.000Z" });
  });

  it("never returns another PID's wallet (no IDOR)", async () => {
    state.identities.set("pid_a", "active");
    state.identities.set("pid_b", "active");
    state.wallets.set("pid_a", {
      id: "w1",
      chain: "solana",
      address: "addr-1",
      status: "active",
      createdAt: "2026-08-10T12:00:00.000Z",
    });
    const tB = await token("pid_b");

    await request(app.getHttpServer()).get("/v1/wallet/me").set("Cookie", `peridot_access=${tB}`).expect(404);
  });

  it("creates a wallet for the authenticated PID only", async () => {
    state.identities.set("pid_a", "active");
    const t = await token("pid_a");

    const res = await request(app.getHttpServer())
      .post("/v1/wallet")
      .set("Cookie", `peridot_access=${t}`)
      .send({ address: "addr-new" })
      .expect(200);

    expect(res.body.chain).toBe("solana");
    expect(res.body.address).toBe("addr-new");
    expect(res.body).not.toHaveProperty("identityId");
    expect(state.wallets.get("pid_a")?.address).toBe("addr-new");
  });

  it("returns the existing wallet on a duplicate create (no replay beyond cardinality)", async () => {
    state.identities.set("pid_a", "active");
    state.wallets.set("pid_a", {
      id: "w1",
      chain: "solana",
      address: "addr-1",
      status: "active",
      createdAt: "2026-08-10T12:00:00.000Z",
    });
    const t = await token("pid_a");

    const res = await request(app.getHttpServer())
      .post("/v1/wallet")
      .set("Cookie", `peridot_access=${t}`)
      .send({ address: "addr-2" })
      .expect(200);

    expect(res.body.id).toBe("w1");
    expect(res.body.address).toBe("addr-1");
  });

  it("rejects an empty address with 400", async () => {
    state.identities.set("pid_a", "active");
    const t = await token("pid_a");

    await request(app.getHttpServer())
      .post("/v1/wallet")
      .set("Cookie", `peridot_access=${t}`)
      .send({ address: "" })
      .expect(400);
  });
});
