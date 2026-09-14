import { Prisma } from "@prisma/client";

/** Unique-constraint violation (concurrent idempotent create) — handlers differ per call site, the check doesn't. */
export function isP2002(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
