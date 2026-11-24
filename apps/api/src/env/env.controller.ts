import { Controller, Get, Header } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { pidNetwork } from "../common/network";

/**
 * Self-describing environment endpoint (ANT-287 FR-1).
 *
 * Public and unauthenticated on both stacks. Every value is server-derived —
 * any client-supplied `?env=` / body value is ignored (never read), so a
 * sandbox build can verify at startup that it reached the intended
 * deployment instead of silently talking to production.
 */
@Controller("v1/env")
export class EnvController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  @Header("Cache-Control", "public, max-age=60")
  env(): { env: string; network: string; dokuMode: string; docs: string } {
    const dokuMode = this.config.get<string>("DOKU_MODE", "sandbox") === "production" ? "production" : "sandbox";
    // The network flag wins: a testnet stack must never advertise itself as
    // production just because its fiat provider is configured for real money.
    const network = pidNetwork(this.config.get<string>("PID_NETWORK"));
    const env = network === "testnet" ? "sandbox" : dokuMode;
    const docs = (this.config.get<string>("DOCS_URL", "") || "").trim() || "https://docs.peridot.id";
    return { env, network, dokuMode, docs };
  }
}
