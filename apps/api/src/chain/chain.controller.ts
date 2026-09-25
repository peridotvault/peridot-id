// Public chain registry read — the SDK and clients discover chains, RPC
// endpoints, and contract addresses from here (no env, no auth).
import { Controller, Get, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { ChainRegistryService, RegistryChain } from "./chain-registry.service";

@Controller("v1/chains")
@UseGuards(ThrottlerGuard)
export class ChainController {
  constructor(private readonly chains: ChainRegistryService) {}

  @Get()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  list(): Promise<RegistryChain[]> {
    return this.chains.activeChains();
  }
}
