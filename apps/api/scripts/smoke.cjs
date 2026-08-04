const { PrismaClient } = require("@prisma/client");
const { JwtService } = require("@nestjs/jwt");
const { randomUUID } = require("crypto");

const BASE = "http://localhost:3301";
const jwt = new JwtService({});

const config = {
  DATABASE_URL: process.env.DATABASE_URL || "postgresql://ranaufal@localhost:5432/peridot",
  ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || "dev-access-secret-please-change-0123456789abcdef",
  REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || "dev-refresh-secret-please-change-0123456789abcdef",
};

const prisma = new PrismaClient({ datasources: { db: { url: config.DATABASE_URL } } });

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log("PASS", name);
  } else {
    fail++;
    console.log("FAIL", name);
  }
}

async function main() {
  const identity = await prisma.identity.create({ data: {} });
  await prisma.profile.create({ data: { identityId: identity.id, displayName: "Smoke Test" } });
  const device = await prisma.device.create({ data: { identityId: identity.id, userAgent: "smoke" } });

  const access = await jwt.signAsync(
    { sub: identity.id, type: "access" },
    { secret: config.ACCESS_SECRET, expiresIn: "15m" },
  );
  const jti = randomUUID();
  const refresh = await jwt.signAsync(
    { sub: identity.id, jti, type: "refresh" },
    { secret: config.REFRESH_SECRET, expiresIn: "30d" },
  );
  await prisma.session.create({
    data: { id: jti, deviceId: device.id, rotatedFrom: null, expiresAt: new Date(Date.now() + 30 * 86400000) },
  });

  const jar = new Map();
  jar.set("peridot_refresh", refresh);
  const setCookies = (res) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, v] = pair.split("=");
      jar.set(k, v);
    }
  };
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

  let res = await fetch(`${BASE}/v1/auth/refresh`, { method: "POST", headers: { cookie: cookieHeader() } });
  check("refresh returns 204", res.status === 204);
  setCookies(res);
  const revoked = await prisma.session.findUnique({ where: { id: jti } });
  check("old refresh token session revoked", revoked?.revokedAt != null);

  res = await fetch(`${BASE}/v1/identity/me`, { method: "GET", headers: { cookie: cookieHeader() } });
  check("identity/me returns 200", res.status === 200);
  check("identity/me matches seeded identity", (await res.json()).id === identity.id);

  res = await fetch(`${BASE}/v1/profile/me`, { method: "GET", headers: { cookie: cookieHeader() } });
  check("profile/me returns 200", res.status === 200);
  check("profile displayName seeded", (await res.json()).displayName === "Smoke Test");

  res = await fetch(`${BASE}/v1/profile`, {
    method: "PATCH",
    headers: { cookie: cookieHeader(), "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Renamed", locale: "en-US" }),
  });
  check("profile patch returns 200", res.status === 200);
  const patched = await res.json();
  check("profile patch applied", patched.displayName === "Renamed" && patched.locale === "en-US");

  res = await fetch(`${BASE}/v1/identity/me`);
  check("identity/me 401 without cookie", res.status === 401);

  res = await fetch(`${BASE}/v1/auth/refresh`, {
    method: "POST",
    headers: { cookie: `peridot_refresh=${refresh}` },
  });
  check("reused refresh token 401", res.status === 401);

  res = await fetch(`${BASE}/v1/auth/logout`, { method: "POST", headers: { cookie: cookieHeader() } });
  check("logout returns 200", res.status === 200);
  setCookies(res);

  res = await fetch(`${BASE}/v1/identity/me`, { method: "GET", headers: { cookie: cookieHeader() } });
  check(`identity/me 401 after logout (got ${res.status})`, res.status === 401);

  res = await fetch(`${BASE}/v1/auth/google`);
  check("google route 503 when unconfigured", res.status === 503);

  await prisma.identity.delete({ where: { id: identity.id } });
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
