// Public token registry reads — wallets discover curated tokens (metadata +
// visibility) from here. Admin writes live in AdminService; every write calls
// invalidate(). Reads fail-open to [] so a missing table never breaks Home.
//
// logoUrl points at the API logo proxy (`GET /v1/tokens/logo?key=`), not
// Wasabi directly: the Wasabi account blocks public bucket reads, so wallets
// load logos through the API (year-cached, throttle-guarded).
import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { RegistryToken } from "@peridotvault/pid-types";
import { PrismaService } from "../prisma/prisma.service";

const CACHE_TTL_MS = 60_000;

type DeploymentRow = {
  id: string;
  mint: string;
  decimals: number;
  isVisible: boolean;
  isPinned: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  token: { symbol: string; name: string; logoKey: string | null };
  chain: { namespace: string; reference: string; isActive: boolean };
};

function toView(row: DeploymentRow, apiBase: string): RegistryToken | null {
  // Dead chains never render, even if a deployment row still points at one.
  if (!row.chain.isActive) return null;
  return {
    id: row.id,
    chainNamespace: row.chain.namespace,
    chainReference: row.chain.reference,
    mint: row.mint,
    symbol: row.token.symbol,
    name: row.token.name,
    decimals: row.decimals,
    logoUrl:
      row.token.logoKey && apiBase
        ? `${apiBase.replace(/\/+$/, "")}/v1/tokens/logo?key=${encodeURIComponent(row.token.logoKey)}`
        : null,
    isVisible: row.isVisible,
    isPinned: row.isPinned,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class TokenRegistryService {
  private cache: { at: number; tokens: RegistryToken[] } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  /** Drop the cache — called by every admin token write. */
  invalidate(): void {
    this.cache = null;
  }

  /** Visible deployments, optionally scoped to one chain. Fail-open to []. */
  async visibleTokens(namespace?: string, reference?: string): Promise<RegistryToken[]> {
    const now = Date.now();
    if (!this.cache || now - this.cache.at >= CACHE_TTL_MS) {
      try {
        const apiBase = (this.config?.get<string>("API_URL") ?? process.env.API_URL ?? "").trim();
        const rows = (await this.prisma.tokenDeployment.findMany({
          where: { isVisible: true },
          include: { token: true, chain: true },
          orderBy: [{ sortOrder: "asc" }, { token: { symbol: "asc" } }],
        })) as DeploymentRow[];
        this.cache = {
          at: now,
          tokens: rows.map((r) => toView(r, apiBase)).filter((t): t is RegistryToken => t !== null),
        };
      } catch {
        return [];
      }
    }
    return this.cache.tokens.filter(
      (t) => (!namespace || t.chainNamespace === namespace) && (!reference || t.chainReference === reference),
    );
  }
}
