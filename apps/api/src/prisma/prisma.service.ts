import { PrismaClient } from "@prisma/client";
import { isTestnetNetwork } from "../common/network";
import { pidsInCreateData, SHADOWABLE_PID_MODELS } from "./pid-ref";

/**
 * DI token for the Prisma client. Nothing constructs it directly — the module
 * provides the instance built by `createPrismaClient()` so the token keeps the
 * class type every module already injects.
 */
export class PrismaService extends PrismaClient {}

/**
 * Testnet stack: identity lives in the mainnet DB, so a pid-keyed write must
 * first materialise a bare `Identity` row (pid only) to satisfy the foreign
 * keys. Mainnet needs no hook — a missing identity there is a real bug.
 *
 * shortcut: one `$allOperations` extension instead of per-service upserts;
 * revisit if a pid-keyed model ever needs a non-shadow identity row.
 */
export function createPrismaClient(): PrismaService {
  const base = new PrismaClient();
  if (!isTestnetNetwork()) return base as PrismaService;
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, args, query }) {
          if (model && SHADOWABLE_PID_MODELS.has(model)) {
            for (const pid of pidsInCreateData((args as { data?: unknown }).data)) {
              // Raw client on purpose: the extension never runs for Identity.
              await base.identity.upsert({ where: { pid }, create: { pid }, update: {} });
            }
          }
          return query(args);
        },
      },
    },
  }) as unknown as PrismaService;
}
