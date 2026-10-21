/**
 * ANT-317 regression guard: every DateTime field in the Prisma schema must map
 * to TIMESTAMPTZ, never to naive `timestamp without time zone`.
 *
 * Root cause of the 7h webhook-dispatch skew in non-UTC deployments: naive
 * timestamp columns stored DB-default `now()` walls in the session TZ
 * (Asia/Jakarta) while the Prisma driver binds/compares UTC walls, so
 * `nextAttemptAt <= now` missed freshly enqueued rows for ~UTC-offset and
 * `expiresAt > now` stayed true past expiry. A new DateTime field without
 * `@db.Timestamptz(3)` reintroduces the class — this test fails first.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("prisma DateTime columns are timestamptz (ANT-317)", () => {
  const schema = readFileSync(join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");

  it("every DateTime field carries @db.Timestamptz", () => {
    const offenders: string[] = [];
    for (const [n, line] of schema.split("\n").entries()) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || !/\bDateTime\??\b/.test(trimmed)) continue;
      if (!trimmed.includes("@db.Timestamptz")) offenders.push(`${n + 1}: ${trimmed}`);
    }
    expect(offenders).toEqual([]);
  });

  it("hot-path due/expiry columns are covered", () => {
    for (const col of ["nextAttemptAt", "expiresAt", "deliveredAt", "consumedAt"]) {
      const lines = schema.split("\n").filter((l) => new RegExp(`\\b${col}\\b.*DateTime`).test(l));
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(l).toContain("@db.Timestamptz");
    }
  });
});
