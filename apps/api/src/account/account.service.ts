import { Injectable, NotFoundException } from "@nestjs/common";
import { ChainAccountStatus } from "@prisma/client";
import { deriveEvmSmartAccountAddress } from "@peridotvault/pid-evm";
import { ChainRegistryService } from "../chain/chain-registry.service";
import { ACCOUNT_TYPE_SMART } from "../common/chains";
import { deriveSmartAccountAddress } from "../common/smart-account";
import { isP2002 } from "../prisma/prisma-error";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";

export interface ChainAccountView {
  id: string;
  chainNamespace: string;
  chainReference: string;
  address: string;
  accountType: string;
  status: ChainAccountStatus;
  activationBalance: number | null;
  activationRequired: number | null;
  createdAt: Date;
}

export function toChainView(ca: {
  id: string;
  chain: { namespace: string; reference: string };
  address: string;
  accountType: string;
  status: ChainAccountStatus;
  activationBalance: bigint | null;
  activationRequired: bigint | null;
  createdAt: Date;
}): ChainAccountView {
  return {
    id: ca.id,
    chainNamespace: ca.chain.namespace,
    chainReference: ca.chain.reference,
    address: ca.address,
    accountType: ca.accountType,
    status: ca.status,
    activationBalance: ca.activationBalance == null ? null : Number(ca.activationBalance),
    activationRequired: ca.activationRequired == null ? null : Number(ca.activationRequired),
    createdAt: ca.createdAt,
  };
}

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly security: SecurityEventService,
    private readonly chains: ChainRegistryService,
  ) {}

  private async programId(): Promise<string> {
    return this.chains.solanaProgramId();
  }

  /**
   * EVM counterfactual rows: one CREATE2 address per deployable registry chain,
   * each from its own factory/implementation contracts (same values everywhere
   * today = one address everywhere). Skipped until a chain has both contracts.
   */
  private async ensureEvmRows(pid: string): Promise<void> {
    for (const chain of await this.chains.deployableEvmChains()) {
      const factory = chain.contracts.find((k) => k.type === "factory")?.address;
      const implementation = chain.contracts.find((k) => k.type === "account_implementation")?.address;
      if (!factory || !implementation) continue;
      const evm = deriveEvmSmartAccountAddress(pid, factory, implementation);
      const existing = await this.prisma.chainAccount.findFirst({
        where: { pid, chainId: chain.id, accountType: ACCOUNT_TYPE_SMART },
      });
      if (!existing) {
        try {
          await this.prisma.chainAccount.create({
            data: {
              pid,
              chainId: chain.id,
              address: evm.address,
              accountType: ACCOUNT_TYPE_SMART,
            },
          });
        } catch (err) {
          if (!isP2002(err)) throw err;
        }
      } else if (existing.address !== evm.address) {
        await this.prisma.chainAccount.update({
          where: { id: existing.id },
          data: { address: evm.address, status: "inactivated", activationBalance: null, activationRequired: null },
        });
      }
    }
  }

  /**
   * Idempotent wallet setup for the token identity: ensures the Solana
   * smart-account row (derived PDA) plus EVM counterfactuals, then returns
   * every chain row. 1 identity = 1 personal wallet.
   */
  async ensureAccount(pid: string): Promise<ChainAccountView[]> {
    // Resolve the program id (registry) before any DB write so it can't orphan rows.
    const programId = await this.programId();

    // The smart-account address is deterministically resolvable before on-chain
    // initialization — seed the chain_accounts row with the derived PDA address.
    const derived = deriveSmartAccountAddress(pid, programId).address;
    const existingChain = await this.prisma.chainAccount.findFirst({
      where: { pid, accountType: ACCOUNT_TYPE_SMART },
    });
    if (!existingChain) {
      const chainId = await this.chains.solanaChainIdOrThrow();
      try {
        await this.prisma.chainAccount.create({
          data: {
            pid,
            chainId,
            address: derived,
            accountType: ACCOUNT_TYPE_SMART,
          },
        });
        await this.security.log(pid, "account.created", {});
      } catch (err) {
        // concurrent create → already present; P2002 is fine.
        if (!isP2002(err)) throw err;
      }
    } else if (existingChain.address !== derived) {
      // Re-point the stored address to the current program id's PDA (e.g. after an on-chain
      // program redeploy changed the program id). Without this, balance reads and activation
      // would target a stale address that holds no funds.
      await this.prisma.chainAccount.update({
        where: { id: existingChain.id },
        data: { address: derived, status: "inactivated", activationBalance: null, activationRequired: null },
      });
    }

    await this.ensureEvmRows(pid);

    return this.getChains(pid);
  }

  /** Every chain row of the token identity's wallet. */
  async getChains(pid: string): Promise<ChainAccountView[]> {
    const rows = await this.prisma.chainAccount.findMany({
      where: { pid },
      include: { chain: true },
      orderBy: { createdAt: "asc" },
    });
    if (rows.length === 0) throw new NotFoundException("Account not found");
    return rows.map(toChainView);
  }
}
