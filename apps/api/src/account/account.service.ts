import { Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ChainAccountStatus, IdentityStatus } from "@prisma/client";
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

export interface AccountView {
  id: string;
  status: IdentityStatus;
  version: number;
  createdAt: Date;
  chainAccounts: ChainAccountView[];
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

function toView(account: {
  id: string;
  status: IdentityStatus;
  version: number;
  createdAt: Date;
  chainAccounts: { id: string; chain: { namespace: string; reference: string }; address: string; accountType: string; status: ChainAccountStatus; activationBalance: bigint | null; activationRequired: bigint | null; createdAt: Date }[];
}): AccountView {
  return {
    id: account.id,
    status: account.status,
    version: account.version,
    createdAt: account.createdAt,
    chainAccounts: account.chainAccounts.map(toChainView),
  };
}

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly security: SecurityEventService,
    private readonly chains: ChainRegistryService,
  ) {}

  private programId(): string {
    return this.config.getOrThrow<string>("PID_PROGRAM_ID");
  }

  /**
   * EVM counterfactual rows: one CREATE2 address per deployable registry chain,
   * each from its own factory/implementation contracts (same values everywhere
   * today = one address everywhere). Skipped until a chain has both contracts.
   */
  private async ensureEvmRows(accountId: string): Promise<void> {
    for (const chain of await this.chains.deployableEvmChains()) {
      const factory = chain.contracts.find((k) => k.type === "factory")?.address;
      const implementation = chain.contracts.find((k) => k.type === "account_implementation")?.address;
      if (!factory || !implementation) continue;
      const evm = deriveEvmSmartAccountAddress(accountId, factory, implementation);
      const existing = await this.prisma.chainAccount.findFirst({
        where: { accountId, chainId: chain.id, accountType: ACCOUNT_TYPE_SMART },
      });
      if (!existing) {
        try {
          await this.prisma.chainAccount.create({
            data: {
              accountId,
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

  /** Find or create the identity's default Peridot account + its smart-account chain row. */
  async createAccount(pid: string): Promise<AccountView> {
    // Read env before any DB write so a missing PID_PROGRAM_ID can't orphan rows.
    const programId = this.programId();
    let account = await this.prisma.pidAccount.findFirst({ where: { pid, status: "active" } });
    if (!account) {
      account = await this.prisma.pidAccount.create({ data: { pid } });
      await this.security.log(pid, "account.created", {}, account.id);
    }

    // ADR 004 §5: the smart-account address is deterministically resolvable before on-chain
    // initialization — seed the chain_accounts row with the derived PDA address.
    const derived = deriveSmartAccountAddress(account.id, programId).address;
    const existingChain = await this.prisma.chainAccount.findFirst({
      where: { accountId: account.id, accountType: ACCOUNT_TYPE_SMART },
    });
    if (!existingChain) {
      const chainId = await this.chains.solanaChainIdOrThrow();
      try {
        await this.prisma.chainAccount.create({
          data: {
            accountId: account.id,
            chainId,
            address: derived,
            accountType: ACCOUNT_TYPE_SMART,
          },
        });
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

    await this.ensureEvmRows(account.id);

    return this.getAccount(pid, account.id);
  }

  async getAccounts(pid: string): Promise<AccountView[]> {
    const accounts = await this.prisma.pidAccount.findMany({
      where: { pid, status: "active" },
      include: { chainAccounts: { include: { chain: true } } },
      orderBy: { createdAt: "asc" },
    });
    return accounts.map(toView);
  }

  /** Ownership strictly from the token — never a client-supplied identity. */
  async getAccount(pid: string, accountId: string): Promise<AccountView> {
    return toView(await this.ownedAccount(pid, accountId));
  }

  async getAccountChains(pid: string, accountId: string): Promise<ChainAccountView[]> {
    const account = await this.ownedAccount(pid, accountId);
    return account.chainAccounts.map(toChainView);
  }

  private async ownedAccount(pid: string, accountId: string) {
    const account = await this.prisma.pidAccount.findFirst({
      where: { id: accountId, pid, status: "active" },
      include: { chainAccounts: { include: { chain: true } } },
    });
    if (!account) throw new NotFoundException("Account not found");
    return account;
  }
}