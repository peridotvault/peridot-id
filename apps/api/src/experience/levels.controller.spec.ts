import { INestApplication, NotFoundException, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import request from "supertest";
import { JwtStrategy } from "../auth/jwt.strategy";
import { JWT_AUD_APP, JWT_AUD_SESSION, JWT_ISSUER } from "../common/app-config";
import { PrismaService } from "../prisma/prisma.service";
import { LevelsController } from "./levels.controller";
import { LevelsService, LevelView } from "./levels.service";

// ANT-89 M1: read API is open to ALL authorized apps incl. unverified ones.
// Auth matrix: any valid session/app/SSO token reads; no token (or a wrong
// token class) is 401; unknown/deleted PIDs are 404. XP-permission standing
// is NEVER consulted on reads (it gates the M3 intake path only).
const SECRET = "level-authz-test-secret-0123456789abcdef";
const VIEW: LevelView = {
  pid: "ifal@pid",
  level: 5,
  total_xp: 1701,
  current_level_xp: 1701,
  next_level_xp: 2819,
  progress_percentage: 0,
};

describe("LevelsController authorization (routes)", () => {
  let app: INestApplication;

  const token = (sub: string, audience: string, extra: Record<string, unknown> = {}) =>
    new JwtService({}).signAsync({ sub, type: "access", ...extra }, { secret: SECRET, issuer: JWT_ISSUER, audience });

  beforeAll(async () => {
    const prisma = {
      identity: {
        findUnique: jest.fn(async ({ where }: { where: { pid: string } }) => {
          if (where.pid === "ghost@pid") return null;
          return { status: "active" };
        }),
      },
    };
    const levels = {
      getLevelView: jest.fn(async (pid: string) => {
        // Mirror the service contract: only well-formed live PIDs resolve.
        if (!/^[a-z0-9_]{3,20}@pid$/.test(pid) || pid === "ghost@pid") {
          throw new NotFoundException("Unknown user");
        }
        return { ...VIEW, pid };
      }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ name: "default", ttl: 60000, limit: 100 }])],
      controllers: [LevelsController],
      providers: [
        { provide: LevelsService, useValue: levels },
        JwtStrategy,
        { provide: ConfigService, useValue: { get: jest.fn(), getOrThrow: jest.fn(() => SECRET) } },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects unauthenticated reads (401)", async () => {
    await request(app.getHttpServer()).get("/v1/users/ifal@pid/level").expect(401);
  });

  it("rejects a refresh-class token used as access (401)", async () => {
    const t = await new JwtService({}).signAsync(
      { sub: "ifal@pid", type: "refresh" },
      { secret: SECRET, issuer: JWT_ISSUER, audience: JWT_AUD_SESSION },
    );
    await request(app.getHttpServer()).get("/v1/users/ifal@pid/level").set("Authorization", `Bearer ${t}`).expect(401);
  });

  it("user session token reads the level wire shape", async () => {
    const t = await token("ifal@pid", JWT_AUD_SESSION);
    const res = await request(app.getHttpServer())
      .get("/v1/users/ifal@pid/level")
      .set("Authorization", `Bearer ${t}`)
      .expect(200);
    expect(res.body).toEqual(VIEW);
  });

  it("unverified app machine token CAN read (no XP-permission gate on reads)", async () => {
    // No standing lookup exists on this path: the app claim is carried
    // through but never authorized against Verified/xpEnabled.
    const t = await token("reader@pid", JWT_AUD_APP, { app: "pidapp_unverified" });
    const res = await request(app.getHttpServer())
      .get("/v1/users/ifal@pid/level")
      .set("Authorization", `Bearer ${t}`)
      .expect(200);
    expect(res.body).toMatchObject({ pid: "ifal@pid", level: 5, total_xp: 1701 });
  });

  it("unknown PID is 404 (privacy: no existence oracle beyond the guard)", async () => {
    const t = await token("ifal@pid", JWT_AUD_SESSION);
    await request(app.getHttpServer()).get("/v1/users/ghost@pid/level").set("Authorization", `Bearer ${t}`).expect(404);
  });

  it("malformed PID is 404, not 500", async () => {
    const t = await token("ifal@pid", JWT_AUD_SESSION);
    await request(app.getHttpServer()).get("/v1/users/notapid/level").set("Authorization", `Bearer ${t}`).expect(404);
  });
});
