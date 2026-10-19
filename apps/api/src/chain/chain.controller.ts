// Public chain registry read — the SDK and clients discover chains, RPC
// endpoints, and contract addresses from here (no env, no auth).
import { Controller, Get, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { ChainRegistryService, RegistryChain, SolanaMainnetAvailability } from "./chain-registry.service";

@Controller("v1/chains")
@UseGuards(ThrottlerGuard)
export class ChainController {
  constructor(private readonly chains: ChainRegistryService) {}

  @Get()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  list(): Promise<RegistryChain[]> {
    return this.chains.activeChains();
  }

  /**
   * Mainnet Solana presence signal (ANT-75, contract for ANT-73). Public,
   * no auth — the wallet calls this pre-login to decide whether Solana
   * create/activate UI is offered in mainnet mode.
   *
   * Contract: 200 `{ available, reference, program, rpcUrl }`. While no
   * mainnet Solana program exists (both seeded rows are testnet):
   * `{ available: false, reference: null, program: null, rpcUrl: null }`.
   * When a mainnet program ships as a registry row, `available` flips to
   * true with that row's reference/program/rpcUrl — no wallet change needed.
   * No mainnet row is created here (ANT-73 explicitly forbids it).
   */
  @Get("solana-availability")
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  solanaAvailability(): Promise<SolanaMainnetAvailability> {
    return this.chains.solanaMainnetAvailability();
  }
}
