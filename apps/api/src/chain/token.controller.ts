// Public token registry read — wallets join on-chain balances with these
// curated rows for name/symbol/logo (no auth, no third-party APIs).
import { Controller, Get, NotFoundException, Query, Res, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import type { RegistryToken } from "@peridotvault/pid-types";
import { Response } from "express";
import { WasabiStorageService } from "../common/wasabi-storage";
import { TokenRegistryService } from "./token-registry.service";

@Controller("v1/tokens")
@UseGuards(ThrottlerGuard)
export class TokenController {
  constructor(
    private readonly tokens: TokenRegistryService,
    private readonly storage: WasabiStorageService,
  ) {}

  @Get()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  list(
    @Query("namespace") namespace?: string,
    @Query("reference") reference?: string,
  ): Promise<RegistryToken[]> {
    return this.tokens.visibleTokens(namespace, reference);
  }

  /**
   * Logo bytes (proxy — the Wasabi account blocks public bucket reads, so
   * wallets load `logoUrl` through here, not Wasabi directly). Immutable +
   * year-cached: keys are content-addressed by mint, never overwritten with
   * different bytes. Unknown keys 404 (never leak bucket internals).
   */
  @Get("logo")
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  async logo(@Query("key") key: string, @Res() res: Response): Promise<void> {
    const file = await this.storage.getLogo(typeof key === "string" ? key : "").catch(() => null);
    if (!file) throw new NotFoundException("Logo not found");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.type(file.contentType).send(file.bytes);
  }
}
