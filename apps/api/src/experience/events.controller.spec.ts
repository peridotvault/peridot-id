import { INestApplication, ValidationPipe } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { Test, TestingModule } from "@nestjs/testing";
import { getOptionsToken, ThrottlerModule } from "@nestjs/throttler";
import request from "supertest";
import { PidAppsService } from "../auth/apps.service";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { skipIfAnon, skipIfAuthed, USER_THROTTLER, userThrottleTracker } from "../common/user-throttle";
import { PrismaService } from "../prisma/prisma.service";
import { AppCredentialGuard } from "./app-credential.guard";
import { EventsController } from "./events.controller";
import { EventsService } from "./events.service";
import { IntakeThrottleAlertFilter } from "./intake-throttle.filter";
import { XP_INTAKE_APP_PID_THROTTLER, XP_INTAKE_APP_THROTTLER, xpIntakeAppPidTracker, xpIntakeAppTracker } from "./rate-limit";

/**
 * ANT-89 M3 (ANT-441) — intake route contract.
 *
 * - C2 lock: POST /v1/experience/events carries AppCredentialGuard and NEVER
 *   JwtAuthGuard (no cookie/JWT sessions on intake). A valid session cookie
 *   alone is 401.
 * - F6 lock: client-supplied xp/amount fields are stripped by the boundary
 *   (whitelist) and can never influence the award.
 * - Uniform 401 envelope carries no secret material.
 */
const SECRET = "pidsk_controller_test_secret_0123456789abcdef";

describe("EventsController (intake route)", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  const submit = jest.fn();

  const appRow = () => ({
    id: "app-1",
    clientId: "pidapp_test",
    ownerPid: "owner@pid",
    isActive: true,
    isVerified: true,
    xpEnabled: true,
    approvedEventTypes: ["onboarding_completed"],
    clientSecretHash: PidAppsService.hashSecret(SECRET),
    clientSecretExpiresAt: new Date(Date.now() + 3600_000),
    prevClientSecretHash: null,
    prevClientSecretExpiresAt: null,
  });

  beforeAll(async () => {
    const prisma = {
      pidApp: { findUnique: jest.fn(async () => appRow()) },
      xpSuspiciousActivity: { create: jest.fn(async (a: unknown) => a) },
    };
    moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          // Production-shaped buckets (same S3 rule as the per-app tiers):
          // the spec must mirror the skipIf split, or it would exercise a
          // wiring that never ships.
          { name: "default", ttl: 60000, limit: 100, skipIf: skipIfAuthed },
          { ...USER_THROTTLER, skipIf: skipIfAnon, getTracker: userThrottleTracker },
          // S3 (Tobias re-review): mirror production wiring — the named tiers
          // MUST carry their getTracker keying here too, or the spec would
          // exercise IP-keyed buckets instead of the shipped per-app keying.
          { ...XP_INTAKE_APP_THROTTLER, getTracker: xpIntakeAppTracker },
          { ...XP_INTAKE_APP_PID_THROTTLER, getTracker: xpIntakeAppPidTracker },
        ]),
      ],
      controllers: [EventsController],
      providers: [
        { provide: EventsService, useValue: { submitEvent: submit } },
        { provide: PrismaService, useValue: prisma },
        PidAppsService,
        AppCredentialGuard,
        IntakeThrottleAlertFilter,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    submit.mockReset();
    submit.mockResolvedValue({ status: "awarded", awarded_xp: 20, level: 1, leveledUp: false });
  });

  const body = (overrides: Record<string, unknown> = {}) => ({
    client_id: "pidapp_test",
    client_secret: SECRET,
    event_id: "evt-1",
    user_id: "user@pid",
    event_type: "onboarding_completed",
    ...overrides,
  });

  it("awards with valid app credentials and no session", async () => {
    const res = await request(app.getHttpServer()).post("/v1/experience/events").send(body()).expect(200);
    expect(res.body).toMatchObject({ status: "awarded", awarded_xp: 20 });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).not.toHaveProperty("xp");
  });

  it("a valid session cookie alone is 401 (C2: never cookie sessions)", async () => {
    await request(app.getHttpServer())
      .post("/v1/experience/events")
      .set("Cookie", "pid_access=valid-looking-session")
      .send({ event_id: "evt-1", user_id: "user@pid", event_type: "onboarding_completed" })
      .expect(401);
    expect(submit).not.toHaveBeenCalled();
  });

  it("wrong secret is uniform 401 with no secret material", async () => {
    const res = await request(app.getHttpServer()).post("/v1/experience/events").send(body({ client_secret: "nope" })).expect(401);
    expect(JSON.stringify(res.body)).not.toContain("nope");
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(JSON.stringify(res.body)).not.toContain("pidsk");
    expect(submit).not.toHaveBeenCalled();
  });

  it("client-supplied xp/amount fields are stripped and ignored (F6)", async () => {
    const res = await request(app.getHttpServer())
      .post("/v1/experience/events")
      .send({ ...body(), xp: 99999, amount: 99999, xpReward: 99999 })
      .expect(200);
    expect(res.body).toMatchObject({ status: "awarded", awarded_xp: 20 });
    const received = submit.mock.calls[0][0] as Record<string, unknown>;
    expect(received).not.toHaveProperty("xp");
    expect(received).not.toHaveProperty("amount");
    expect(received).not.toHaveProperty("xpReward");
  });

  it("malformed event_type is 400", async () => {
    await request(app.getHttpServer()).post("/v1/experience/events").send(body({ event_type: "BAD TYPE!" })).expect(400);
  });

  it("spec module carries production per-app tracker keying (S3 lock)", () => {
    // Reads back the throttler options REGISTERED in this spec module (the
    // exact array handed to forRoot above) — removing getTracker from the
    // wiring fails here, so the spec cannot silently drift back to
    // IP-keyed buckets while production ships per-app keying.
    const registered = moduleRef.get<unknown>(getOptionsToken(), { strict: false }) as Array<{
      name?: string;
      getTracker?: unknown;
    }>;
    const byName = new Map((Array.isArray(registered) ? registered : []).map((o) => [o.name, o]));
    expect(byName.get(XP_INTAKE_APP_THROTTLER.name)?.getTracker).toBe(xpIntakeAppTracker);
    expect(byName.get(XP_INTAKE_APP_PID_THROTTLER.name)?.getTracker).toBe(xpIntakeAppPidTracker);
  });

  it("an over-limit burst on one route 429s with a Retry-After header", async () => {
    // The route has no per-route @Throttle override, so the default (100)
    // applies — 101 rapid hits must trip it, proving the guard is live here.
    // (Named tiers are asserted via their own specs, not by burning budgets.)
    // Sequential, not concurrent: the in-memory budget counts hits, not
    // sockets, and 101 parallel connections would test the test server
    // instead of the guard. client_id varies per hit so the per-app intake
    // tiers (60/min) stay out of the way — the trip must come from the
    // default IP tier (bare `retry-after`, no suffix).
    let limited: { status: number; headers: Record<string, string> } | null = null;
    for (let i = 0; i < 101; i++) {
      const res = await request(app.getHttpServer())
        .post("/v1/experience/events")
        .send(body({ client_id: `burst-app-${i}`, event_id: `burst-${i}` }));
      if (res.status === 429) {
        limited = res;
        break;
      }
    }
    expect(limited).not.toBeNull();
    expect(limited?.headers["retry-after"]).toBeDefined();
  });

  it("production-shaped buckets: verified sessions skip the IP tier", async () => {
    // Module-level integration (S3-style lock, distinct from the unit-level
    // user-throttle.spec): proves the skipIf split end to end — 101 rapid
    // hits with a VALID session token never consume the anonymous budget
    // (no 429 from the IP tier), while the same burst without a token 429s.
    const secret = "bucket-split-test-secret";
    process.env.JWT_ACCESS_SECRET = secret;
    const { sign } = await import("jsonwebtoken");
    const { JWT_ISSUER } = await import("../common/app-config");
    const token = sign({ sub: "ifal@pid", type: "access" }, secret, {
      issuer: JWT_ISSUER,
      audience: "pid-session",
      expiresIn: "1h",
    });
    try {
      // Sequential: the budget counts hits, not sockets. client_id varies per
      // hit so the per-app intake tiers (60/min) stay out of the way — the
      // only tiers in play are default-IP vs user.
      let authedLimited = false;
      for (let i = 0; i < 101; i++) {
        const res = await request(app.getHttpServer())
          .post("/v1/experience/events")
          .set("Authorization", `Bearer ${token}`)
          .send(body({ client_id: `authed-app-${i}`, event_id: `authed-${i}` }));
        // 401s (no such app) are fine — the point is NO 429 from the IP tier.
        if (res.status === 429) {
          authedLimited = true;
          break;
        }
      }
      expect(authedLimited).toBe(false);

      let anonLimited = false;
      for (let i = 0; i < 101; i++) {
        const res = await request(app.getHttpServer())
          .post("/v1/experience/events")
          .send(body({ client_id: `anon-app-${i}`, event_id: `anon-${i}` }));
        if (res.status === 429) {
          anonLimited = true;
          break;
        }
      }
      expect(anonLimited).toBe(true);
    } finally {
      delete process.env.JWT_ACCESS_SECRET;
    }
  });
});

describe("intake guard surface (C2 lock)", () => {
  it("POST /v1/experience/events uses AppCredentialGuard and NOT JwtAuthGuard", () => {
    const proto = EventsController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, EventsController) ?? [];
    const handlerGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, proto.submit) ?? [];
    const guards = [...classGuards, ...handlerGuards];
    expect(guards).toContain(AppCredentialGuard);
    expect(guards).not.toContain(JwtAuthGuard);
  });
});
