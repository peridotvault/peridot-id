import { Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ChainAccountStatus, IdentityStatus, Prisma } from "@prisma/client";
import { deriveSmartAccountAddress } from "../common/smart-account";
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

const SOLANA_NAMESPACE = "solana";
const SOLANA_MAINNET_REFERENCE = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z";
const ACCOUNT_TYPE_SMART = "smart_account";

function toChainView(ca: {
  id: string;
  chainNamespace: string;
  chainReference: string;
  address: string;
  accountType: string;
  status: ChainAccountStatus;
  activationBalance: bigint | null;
  activationRequired: bigint | null;
  createdAt: Date;
}): ChainAccountView {
  return {
    id: ca.id,
    chainNamespace: ca.chainNamespace,
    chainReference: ca.chainReference,
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
  chainAccounts: { id: string; chainNamespace: string; chainReference: string; address: string; accountType: string; status: ChainAccountStatus; activationBalance: bigint | null; activationRequired: bigint | null; createdAt: Date }[];
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
  ) {}

  private programId(): string {
    return this.config.getOrThrow<string>("PID_PROGRAM_ID");
  }

  /** Find or create the identity's default Peridot account + its smart-account chain row. */
  async createAccount(identityId: string): Promise<AccountView> {
    // Read env before any DB write so a missing PID_PROGRAM_ID can't orphan rows.
    const programId = this.programId();
    let account = await this.prisma.pidAccount.findFirst({ where: { identityId, status: "active" } });
    if (!account) {
      account = await this.prisma.pidAccount.create({ data: { identityId } });
      await this.security.log(identityId, "account.created", {}, account.id);
    }

    // ADR 004 §5: the smart-account address is deterministically resolvable before on-chain
    // initialization — seed the chain_accounts row with the derived PDA address.
    const derived = deriveSmartAccountAddress(account.id, programId).address;
    const existingChain = await this.prisma.chainAccount.findFirst({
      where: { accountId: account.id, accountType: ACCOUNT_TYPE_SMART },
    });
    if (!existingChain) {
      try {
        await this.prisma.chainAccount.create({
          data: {
            accountId: account.id,
            chainNamespace: SOLANA_NAMESPACE,
            chainReference: SOLANA_MAINNET_REFERENCE,
            address: derived,
            accountType: ACCOUNT_TYPE_SMART,
          },
        });
      } catch (err) {
        // concurrent create → already present; P2002 is fine.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
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

    return this.getAccount(identityId, account.id);
  }

  async getAccounts(identityId: string): Promise<AccountView[]> {
    const accounts = await this.prisma.pidAccount.findMany({
      where: { identityId, status: "active" },
      include: { chainAccounts: true },
      orderBy: { createdAt: "asc" },
    });
    return accounts.map(toView);
  }

  /** Ownership strictly from the token — never a client-supplied identity. */
  async getAccount(identityId: string, accountId: string): Promise<AccountView> {
    const account = await this.prisma.pidAccount.findFirst({
      where: { id: accountId, identityId, status: "active" },
      include: { chainAccounts: true },
    });
    if (!account) throw new NotFoundException("Account not found");
    return toView(account);
  }

  async getAccountChains(identityId: string, accountId: string): Promise<ChainAccountView[]> {
    const account = await this.prisma.pidAccount.findFirst({
      where: { id: accountId, identityId, status: "active" },
      include: { chainAccounts: true },
    });
    if (!account) throw new NotFoundException("Account not found");
    return account.chainAccounts.map(toChainView);
  }
}