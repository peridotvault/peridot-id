// EVM counterfactual activation (mirrors activation.service.ts state machine).
//
// The address exists before deployment: users can fund it, anyone can observe it,
// and the Peridot relayer deploys (`deployAndInit`) once it is READY. Status rows
// never carry wei balances (they overflow the int64 columns) — `viewOf` reads
// chain state live and returns wei as strings.

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ChainAccountStatus } from "@prisma/client";
import { EvmAdapter, EvmRpc } from "@peridotvault/pid-evm";
import { ChainRegistryService, type RegistryChain } from "../chain/chain-registry.service";
import { coseToRawXy } from "../credentials/cose";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";

export interface EvmActivationView {
  accountId: string;
  chainReference: string;
  status: string;
  smartAccountAddress: string;
  deployed: boolean;
  balanceWei: string;
  requiredWei: string;
}

const ACCOUNT_TYPE = "smart_account";
// `initialize` selector + deploy estimate headroom (measured ~250k, margin via rate).
const DEPLOY_GAS_ESTIMATE = 350_000n;

@Injectable()
export class EvmActivationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EvmActivationService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly security: SecurityEventService,
    private readonly chains: ChainRegistryService,
  ) {}

  onModuleInit(): void {
    const intervalMs = Number(this.config.get<string>("PID_EVM_POLL_MS", "30000"));
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.poll().catch((err) => this.logger.error(`evm poll error: ${(err as Error).message}`));
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Registry chain or 404 (unknown/deactivated references are not addressable). */
  private async chainOrThrow(chainReference: string): Promise<RegistryChain> {
    const chain = await this.chains.chainByReference(chainReference);
    if (!chain || chain.namespace !== "eip155") throw new NotFoundException("Unsupported EVM chain");
    return chain;
  }

  private async rpcFor(chainReference: string): Promise<EvmRpc> {
    return new EvmRpc(await this.chains.rpcUrlForReference(chainReference));
  }

  private async adapterFor(chainReference: string): Promise<EvmAdapter> {
    const deployment = await this.chains.deploymentFor(chainReference);
    if (!deployment) throw new ServiceUnavailableException("EVM accounts are not configured yet");
    return new EvmAdapter(await this.rpcFor(chainReference), deployment.factory, deployment.implementation);
  }

  private marginRate(): number {
    const n = Number(this.config.get<string>("PID_ACTIVATION_MARGIN_RATE", "0.5"));
    return Number.isFinite(n) && n >= 0 ? n : 0.5;
  }

  /** Live deploy cost: static gas estimate × live gas price × (1 + margin). */
  private async requiredWei(chainReference: string): Promise<bigint> {
    const rpc = await this.rpcFor(chainReference);
    // 1 gwei fallback when the node hides the price.
    const gasPrice = await rpc.gasPrice().catch(() => 1_000_000_000n);
    const margin = BigInt(Math.round(this.marginRate() * 100));
    return (DEPLOY_GAS_ESTIMATE * gasPrice * (100n + margin)) / 100n;
  }

  private classify(balance: bigint, required: bigint, current: string): ChainAccountStatus {
    if (balance === 0n) return "inactivated";
    if (balance < required) return "insufficient";
    if (current === "activating") return "activating";
    return "ready";
  }

  /** Refresh statuses for EVM rows (heal to active once code is deployed). */
  async poll(): Promise<void> {
    const pending = await this.prisma.chainAccount.findMany({
      where: { chainNamespace: "eip155", accountType: ACCOUNT_TYPE },
      include: { account: { select: { identityId: true } } },
    });
    for (const ca of pending) {
      try {
        // Rows for deactivated/unknown chains are left alone (admin kill-switch).
        if (!(await this.chains.chainByReference(ca.chainReference))) continue;
        const rpc = await this.rpcFor(ca.chainReference);
        const code = await rpc.getCode(ca.address);
        const deployed = code !== "0x" && code.length > 2;
        if (deployed && ca.status !== "active") {
          await this.prisma.chainAccount.update({ where: { id: ca.id }, data: { status: "active" } });
          await this.security.log(ca.account.identityId, "account.evm.promoted", { to: "active" }, ca.accountId);
          continue;
        }
        if (ca.status === "active") continue;
        const balance = await rpc.getBalance(ca.address);
        const required = await this.requiredWei(ca.chainReference).catch(() => 0n);
        const next = this.classify(balance, required, ca.status);
        if (next !== ca.status) {
          await this.prisma.chainAccount.update({ where: { id: ca.id }, data: { status: next } });
        }
      } catch (err) {
        this.logger.warn(`evm poll failed for ${ca.address}: ${(err as Error).message}`);
      }
    }
  }

  async viewOf(user: { identityId: string }, accountId: string, chainReference: string): Promise<EvmActivationView> {
    await this.chainOrThrow(chainReference);
    const row = await this.ownedRow(user.identityId, accountId, chainReference);
    const rpc = await this.rpcFor(chainReference);
    let balance = 0n;
    let deployed = false;
    try {
      [balance, deployed] = await Promise.all([
        rpc.getBalance(row.address),
        rpc.getCode(row.address).then((code) => code !== "0x" && code.length > 2),
      ]);
    } catch (err) {
      this.logger.warn(`evm view failed for ${row.address}: ${(err as Error).message}`);
    }
    const required = await this.requiredWei(chainReference).catch(() => 0n);
    const status = deployed ? "active" : this.classify(balance, required, row.status);
    return {
      accountId: row.accountId,
      chainReference,
      status,
      smartAccountAddress: row.address,
      deployed,
      balanceWei: balance.toString(),
      requiredWei: required.toString(),
    };
  }

  /**
   * Deploy the counterfactual via the Peridot relayer (`deployAndInit` with the
   * registered passkey as authority). Idempotent once ACTIVE.
   */
  async activate(user: { identityId: string }, accountId: string, chainReference: string): Promise<EvmActivationView> {
    const chain = await this.chainOrThrow(chainReference);
    const row = await this.ownedRow(user.identityId, accountId, chainReference);
    const adapter = await this.adapterFor(chainReference);

    const live = await this.viewOf(user, accountId, chainReference);
    if (live.status === "active") return live;
    if (live.status !== "ready") {
      throw new ConflictException(`Wallet must be READY to activate (currently ${live.status})`);
    }

    const authority = await this.prisma.authority.findFirst({
      where: { accountId, status: "active" },
      orderBy: { createdAt: "asc" },
    });
    if (!authority) throw new ConflictException("No passkey registered — register one first");

    const secret = this.config.get<string>("EVM_RELAYER_SECRET");
    if (!secret || !/^0x[0-9a-fA-F]{64}$/.test(secret)) {
      // No relayer key: the operator deploys with the forge script, then this
      // endpoint confirms ACTIVE. Never silently skip deployment.
      throw new ServiceUnavailableException(
        "EVM auto-deploy is not configured — deploy with contracts/evm (script/Deploy.s.sol) then retry.",
      );
    }

    await this.prisma.chainAccount.update({ where: { id: row.id }, data: { status: "activating" } });
    try {
      const { x, y } = coseToRawXy(Buffer.from(authority.publicKey));
      const rpIdHash = await this.sha256Hex(this.config.get<string>("WEBAUTHN_RP_ID", "localhost"));
      const data = adapter.buildDeployAndInitData(
        adapter.getSalt(accountId),
        new Uint8Array(x),
        new Uint8Array(y),
        rpIdHash,
      );
      const receipt = await this.sendDeployTx(chainReference, secret as `0x${string}`, data);
      await this.prisma.chainAccount.update({ where: { id: row.id }, data: { status: "active" } });
      await this.prisma.transaction
        .create({
          data: {
            accountId: row.accountId,
            chainAccountId: row.id,
            type: "ACTIVATION",
            amount: BigInt(receipt.costWei),
            asset: chain.nativeSymbol,
            direction: "out",
            counterparty: receipt.from,
            chain: "eip155",
            network: chain.name,
            txHash: receipt.hash,
            status: "confirmed",
            confirmedAt: new Date(),
          },
        })
        .catch((err) => this.logger.warn(`evm activation activity record failed: ${(err as Error).message}`));
      await this.security.log(user.identityId, "account.evm.activated", { txHash: receipt.hash }, accountId);
    } catch (err) {
      await this.prisma.chainAccount.update({ where: { id: row.id }, data: { status: "ready" } }).catch(() => undefined);
      throw err;
    }
    return this.viewOf(user, accountId, chainReference);
  }

  private async ownedRow(identityId: string, accountId: string, chainReference: string) {
    const row = await this.prisma.chainAccount.findFirst({
      where: { chainNamespace: "eip155", chainReference, accountType: ACCOUNT_TYPE, accountId },
      include: { account: true },
    });
    if (!row || row.account.identityId !== identityId) throw new NotFoundException("Account not found");
    return row;
  }

  private async sha256Hex(s: string): Promise<Uint8Array> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return new Uint8Array(digest);
  }

  /** Lazy viem import (keeps the ESM graph out of Jest unless a deploy runs). */
  private async sendDeployTx(
    chainReference: string,
    secret: `0x${string}`,
    data: string,
  ): Promise<{ hash: string; from: string; costWei: string }> {
    const chain = await this.chainOrThrow(chainReference);
    const chainId = Number(chain.reference);
    if (!Number.isInteger(chainId)) throw new NotFoundException("Unsupported EVM chain");
    const url = await this.chains.rpcUrlForReference(chainReference);
    const viem = (await import("viem")) as typeof import("viem");
    const { privateKeyToAccount } = (await import("viem/accounts")) as typeof import("viem/accounts");
    const account = privateKeyToAccount(secret);
    const publicClient = viem.createPublicClient({ transport: viem.http(url) });
    const walletClient = viem.createWalletClient({
      account,
      chain: {
        id: chainId,
        name: chain.name,
        nativeCurrency: { name: chain.nativeSymbol, symbol: chain.nativeSymbol, decimals: chain.decimals },
        rpcUrls: { default: { http: [url] } },
      },
      transport: viem.http(url),
    });
    const deployment = await this.chains.deploymentFor(chainReference);
    if (!deployment) throw new ServiceUnavailableException("EVM accounts are not configured yet");
    const gas = await publicClient.estimateGas({ to: deployment.factory as `0x${string}`, data: data as `0x${string}` });
    const hash = await walletClient.sendTransaction({ to: deployment.factory as `0x${string}`, data: data as `0x${string}`, gas });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`evm deploy reverted: ${hash}`);
    const gasPrice = receipt.effectiveGasPrice ?? 0n;
    return { hash, from: account.address, costWei: (receipt.gasUsed * gasPrice).toString() };
  }
}
