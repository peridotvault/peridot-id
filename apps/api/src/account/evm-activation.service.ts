// EVM counterfactual activation (mirrors activation.service.ts state machine).
//
// The address exists before deployment: users can fund it, anyone can observe it,
// and the Peridot relayer deploys (`deployAndInit`) once it is READY. Status rows
// never carry wei balances (they overflow the int64 columns) — `viewOf` reads
// chain state live and returns wei as strings.

import {
  BadRequestException,
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
import { createHash } from "node:crypto";
import { EvmAdapter, EvmRpc, buildViewCalldata, splitEvmFeeV2, toHex } from "@peridotvault/pid-evm";
import { ChainRegistryService, type RegistryChain } from "../chain/chain-registry.service";
import { classifyActivation, requireActiveAuthority } from "../common/activation";
import { ACCOUNT_TYPE_SMART, EIP155_NAMESPACE } from "../common/chains";
import {
  feePolicyVersion as configuredPolicyVersion,
  protocolFeeBps,
  protocolFeeOf,
  exceedsDriftBound,
  MAX_TTL_SECS,
} from "../common/solana-relay";
import { coseToRawXy } from "../credentials/cose";
import { PID_EVM_POLL_MS } from "../common/app-config";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import { CircuitBreakerService } from "../relayer/circuit-breaker.service";
import { RelayerIdempotencyService } from "../relayer/relayer-idempotency.service";
import {
  FeeChain,
  IntentRejectionCause,
  RelayerH1Events,
  absorbedLoss,
  evmReferenceToFeeChain,
  fmtBaseUnits,
} from "../relayer/relayer-events";

export interface EvmActivationView {
  pid: string;
  chainReference: string;
  status: string;
  smartAccountAddress: string;
  deployed: boolean;
  balanceWei: string;
  requiredWei: string;
  /** Realtime network-cost estimate the backend will attest near (wei). */
  networkFeeWei: string;
  /** Fixed protocol percentage in bps for the quoted policy version. */
  protocolFeeBps: number;
  /** Signed fee-policy version the quote was computed under (1 sunset, 2 V4 canonical). */
  feePolicyVersion: number;
  /** networkFee + protocolFee at quote time (informational — settles at submit-time values). */
  totalFeeWei: string;
  /** Suggested user-approved bound for submit (`maxTotalFeeWei >= totalFeeWei`, V4 B5). */
  maxTotalFeeWei: string;
}

const ACCOUNT_TYPE = ACCOUNT_TYPE_SMART;
// `initialize` selector + deploy estimate headroom (measured ~250k + V3 assertion calldata).
const DEPLOY_GAS_ESTIMATE = 350_000n;
// OP-Stack L1-fee oracle (Base/OP Sepolia family). Absent chains return 0 (best-effort).
const L1_GAS_ORACLE = "0x420000000000000000000000000000000000000F";
const L1_FEE_SELECTOR = "49904e67"; // getL1Fee(bytes)

@Injectable()
export class EvmActivationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EvmActivationService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly security: SecurityEventService,
    private readonly chains: ChainRegistryService,
    private readonly idempotency: RelayerIdempotencyService,
    private readonly breaker: CircuitBreakerService,
  ) {}

  onModuleInit(): void {
    const intervalMs = PID_EVM_POLL_MS;
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
    if (!chain || chain.namespace !== EIP155_NAMESPACE) throw new NotFoundException("Unsupported EVM chain");
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

  private policyVersion(): number {
    // EVM canonical is V4 policy 2 (MAX 50%, chainMin floor). Policy 1 stays
    // accepted on submit for sunset (frozen semantics: 50% no floor).
    return 2;
  }

  /** H1.ii: semantic intent rejections emit intent.rejected (EVM intents carry no nonce — key omitted). */
  private async reject(pid: string, chain: FeeChain | "unknown", cause: IntentRejectionCause, err: Error): Promise<never> {
    await this.security.log(pid, RelayerH1Events.intentRejected, {
      chain,
      entryPoint: "activate",
      cause,
    });
    throw err;
  }

  /** Chain id numeric for the V2 floor table (reference IS the decimal chain id). */
  private chainIdFor(chain: { reference: string }): number {
    const cid = Number(chain.reference);
    if (!Number.isInteger(cid) || cid <= 0) throw new NotFoundException("Unsupported EVM chain");
    return cid;
  }

  /** Protocol fee for a policy version (1 = frozen 50% no-floor; 2 = V2 MAX with chainMin). */
  private protocolFeeFor(networkFee: bigint, version: number, chainId: number): bigint {
    if (version === 1) return protocolFeeOf(networkFee, protocolFeeBps(version));
    if (version === 2) return splitEvmFeeV2(networkFee, chainId).protocolFee;
    throw new BadRequestException("Unsupported fee policy — re-quote and try again");
  }

  /** Realtime network-cost estimate for the deploy (no margin — the protocol fee is separate). */
  private async networkFeeWei(chainReference: string): Promise<bigint> {
    const rpc = await this.rpcFor(chainReference);
    // 1 gwei fallback when the node hides the price.
    const gasPrice = await rpc.gasPrice().catch(() => 1_000_000_000n);
    return DEPLOY_GAS_ESTIMATE * gasPrice;
  }

  /** Live deploy cost attested by the backend: network estimate + L2 data fee where available. */
  private async requiredWei(chainReference: string): Promise<bigint> {
    return this.networkFeeWei(chainReference);
  }

  /**
   * L1 data fee for a confirmed tx via the OP-Stack oracle (best-effort: 0 when the
   * chain has no oracle). Uses the actual transaction input, so this is exact where
   * the oracle exists — the reconciliation counterpart to the on-chain sanity bound.
   */
  private async l1DataFeeWei(chainReference: string, txHash: string): Promise<bigint> {
    try {
      const rpc = await this.rpcFor(chainReference);
      const tx = await rpc.call<{ input: string }>("eth_getTransactionByHash", [txHash]);
      if (!tx || typeof tx.input !== "string" || tx.input === "0x") return 0n;
      const input = (tx.input.startsWith("0x") ? tx.input.slice(2) : tx.input) as string;
      // getL1Fee(bytes): selector + offset(32) + length(32) + padded bytes.
      const lenHex = input.length / 2;
      const paddedLen = Math.ceil(lenHex / 32) * 32;
      const call =
        `0x${L1_FEE_SELECTOR}` +
        `0000000000000000000000000000000000000000000000000000000000000020` +
        lenHex.toString(16).padStart(64, "0") +
        input.padEnd(paddedLen * 2, "0");
      const res = await rpc.call<string>("eth_call", [{ to: L1_GAS_ORACLE, data: call }, "latest"]);
      return BigInt(res);
    } catch {
      return 0n;
    }
  }

  private classify(balance: bigint, required: bigint, current: string): ChainAccountStatus {
    return classifyActivation(balance, required, current);
  }

  /** Refresh statuses for EVM rows (heal to active once code is deployed). */
  async poll(): Promise<void> {
    const pending = await this.prisma.chainAccount.findMany({
      where: { chain: { namespace: EIP155_NAMESPACE }, accountType: ACCOUNT_TYPE },
      include: { chain: true },
    });
    for (const ca of pending) {
      try {
        // Rows for deactivated/unknown chains are left alone (admin kill-switch).
        if (!(await this.chains.chainByReference(ca.chain.reference))) continue;
        const rpc = await this.rpcFor(ca.chain.reference);
        const code = await rpc.getCode(ca.address);
        const deployed = code !== "0x" && code.length > 2;
        if (!deployed) {
          if (ca.status === "active") continue;
          const balance = await rpc.getBalance(ca.address);
          const networkFee = await this.networkFeeWei(ca.chain.reference).catch(() => 0n);
          const required = networkFee + protocolFeeOf(networkFee, protocolFeeBps(this.policyVersion()));
          const next = this.classify(balance, required, ca.status);
          if (next !== ca.status) {
            await this.prisma.chainAccount.update({ where: { id: ca.id }, data: { status: next } });
          }
          continue;
        }
        // Code alone proves nothing (squat/grief deploys exist): promote only on
        // exact authority match, demote mismatched ACTIVE rows back to ready.
        const matches = await this.deploymentMatches(rpc, ca.address, ca.pid, ca.chain.reference).catch(() => false);
        if (matches) {
          if (ca.status !== "active") {
            await this.prisma.chainAccount.update({ where: { id: ca.id }, data: { status: "active" } });
            await this.security.log(ca.pid, "account.evm.promoted", { to: "active" });
          }
        } else {
          this.logger.warn(`evm authority mismatch for ${ca.address} (possible squat)`);
          if (ca.status === "active") {
            await this.prisma.chainAccount.update({ where: { id: ca.id }, data: { status: "ready" } });
          }
        }
      } catch (err) {
        this.logger.warn(`evm poll failed for ${ca.address}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * True when the deployed proxy is initialized with the registered passkey
   * authority **and** canonically associated with our factory.
   * Fail-closed: any error (no credential, bad RPC) is false.
   */
  private async deploymentMatches(
    rpc: EvmRpc,
    address: string,
    pid: string,
    chainReference: string,
  ): Promise<boolean> {
    const authority = await requireActiveAuthority(this.prisma, pid);
    const { x, y } = coseToRawXy(Buffer.from(authority.publicKey));
    const deployment = await this.chains.deploymentFor(chainReference);
    const v = buildViewCalldata();
    const [init, ax, ay, factory] = await Promise.all([
      rpc.call<string>("eth_call", [{ to: address, data: v.initialized }, "latest"]),
      rpc.call<string>("eth_call", [{ to: address, data: v.authorityX }, "latest"]),
      rpc.call<string>("eth_call", [{ to: address, data: v.authorityY }, "latest"]),
      rpc.call<string>("eth_call", [{ to: address, data: v.factory }, "latest"]),
    ]);
    return (
      BigInt(init) === 1n &&
      ax.toLowerCase() === `0x${toHex(new Uint8Array(x))}` &&
      ay.toLowerCase() === `0x${toHex(new Uint8Array(y))}` &&
      !!deployment &&
      factory.toLowerCase() === `0x${"0".repeat(24)}${deployment.factory.slice(2).toLowerCase()}`
    );
  }

  async viewOf(user: { pid: string }, chainReference: string): Promise<EvmActivationView> {
    const chain = await this.chainOrThrow(chainReference);
    const row = await this.ownedRow(user.pid, chain);
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
    const networkFee = await this.networkFeeWei(chainReference).catch(() => 0n);
    const version = this.policyVersion();
    const chainId = this.chainIdFor(chain);
    const protocolFee = this.protocolFeeFor(networkFee, version, chainId);
    const totalFee = networkFee + protocolFee;
    const status = deployed && (await this.deploymentMatches(rpc, row.address, user.pid, chainReference).catch(() => false))
      ? "active"
      : this.classify(balance, totalFee, row.status);
    // V4 B5: the quote OFFERS the user-approved bound. Suggested max == attested
    // total (client MAY raise it; submit verifies total <= max, B6).
    return {
      pid: user.pid,
      chainReference,
      status,
      smartAccountAddress: row.address,
      deployed,
      balanceWei: balance.toString(),
      requiredWei: totalFee.toString(),
      networkFeeWei: networkFee.toString(),
      protocolFeeBps: 5000,
      feePolicyVersion: version,
      totalFeeWei: totalFee.toString(),
      maxTotalFeeWei: totalFee.toString(),
    };
  }

  /**
   * Deploy the counterfactual via the Peridot relayer (V4 `deployAndInitV4` when
   * policy 2, frozen V3 `deployAndInit` when policy 1 sunset). The user's
   * assertion binds salt, authority, policy, maxTotalFee (V4 only), deadline,
   * chainId and factory (no amounts) — the relayer submits but authorizes
   * nothing. Idempotent once ACTIVE.
   */
  async activate(
    user: { pid: string },
    chainReference: string,
    dto: {
      quotedNetworkFeeWei: string;
      feePolicyVersion: number;
      maxTotalFeeWei?: string;
      deadline: number;
      assertion: { id: string; r: string; s: string; authenticatorData: string; clientDataJSON: string };
    },
  ): Promise<EvmActivationView> {
    const chain = await this.chainOrThrow(chainReference);
    const row = await this.ownedRow(user.pid, chain);
    // FeeChain for every H1/H2/H3 row on this path (unknown testnets bucket to 'unknown').
    const feeChain = evmReferenceToFeeChain(chain.reference);
    const adapter = await this.adapterFor(chainReference);

    const live = await this.viewOf(user, chainReference);
    if (live.status === "active") return live;
    if (live.status !== "ready") {
      throw new ConflictException(`Wallet must be READY to activate (currently ${live.status})`);
    }

    // H3: fail-closed while the per-chain spend-rate breaker is open.
    await this.breaker.requireClosed(chainReference, "activate");

    const authority = await requireActiveAuthority(this.prisma, user.pid);

    // EVM relayer key is dashboard-managed (evm_relayer_keys table, admin-only) —
    // never env. Unset = operator deploys via forge script, then this endpoint
    // confirms ACTIVE. Never silently skip deployment.
    const secret = await this.chains.relayerSecretFor(chainReference);
    if (!secret || !/^0x[0-9a-fA-F]{64}$/.test(secret)) {
      throw new ServiceUnavailableException(
        "EVM auto-deploy is not configured — deploy with contracts/evm (script/Deploy.s.sol) then retry.",
      );
    }

    // Accept policy 1 (sunset, frozen) and 2 (V4 canonical). Quote offers 2;
    // submit must match what the client signed — mismatch means re-quote.
    const version = dto.feePolicyVersion;
    if (version !== 1 && version !== 2) {
      return this.reject(user.pid, feeChain, "policy-unknown", new BadRequestException("Unsupported fee policy — re-quote and try again"));
    }
    const chainId = this.chainIdFor(chain);
    const rpc = await this.rpcFor(chainReference);
    const now = await rpc.blockTimestamp().catch(() => Math.floor(Date.now() / 1000));
    if (dto.deadline <= now) {
      return this.reject(user.pid, feeChain, "expired", new BadRequestException("Authorization expired — please try again"));
    }
    if (dto.deadline - now > MAX_TTL_SECS) {
      return this.reject(user.pid, feeChain, "expired", new BadRequestException("Authorization lifetime exceeds 600 seconds — re-quote and try again"));
    }
    // Attest the realtime network fee at submit time; fail closed when it drifted
    // beyond 120% of what the client quoted against.
    const quoted = BigInt(dto.quotedNetworkFeeWei);
    const networkFee = await this.networkFeeWei(chainReference);
    if (exceedsDriftBound(networkFee, quoted)) {
      await this.security.log(user.pid, RelayerH1Events.driftRejected, {
        chain: feeChain,
        entryPoint: "activate",
        quoted: fmtBaseUnits(quoted),
        attested: fmtBaseUnits(networkFee),
      });
      return this.reject(user.pid, feeChain, "drift", new ConflictException("Network fee moved — re-quote and try again"));
    }
    const protocolFee = this.protocolFeeFor(networkFee, version, chainId);
    const totalFee = networkFee + protocolFee;
    // V4 B6: VERIFY the user-approved bound. total > max reverts on-chain
    // (FeeExceedsMax) — fail closed here before broadcast.
    let maxTotalFee = totalFee;
    if (version === 2) {
      if (dto.maxTotalFeeWei == null) {
        return this.reject(user.pid, feeChain, "policy-unknown", new BadRequestException("maxTotalFeeWei is required for fee policy 2 — re-quote and try again"));
      }
      maxTotalFee = BigInt(dto.maxTotalFeeWei);
      if (totalFee > maxTotalFee) {
        await this.security.log(user.pid, RelayerH1Events.driftRejected, {
          chain: feeChain,
          entryPoint: "activate",
          quoted: fmtBaseUnits(maxTotalFee),
          attested: fmtBaseUnits(totalFee),
        });
        return this.reject(user.pid, feeChain, "drift", new ConflictException("Network fee exceeds maxTotalFee — re-quote and try again"));
      }
    }
    const asserting = await this.prisma.authority.findFirst({
      where: { pid: user.pid, credentialId: dto.assertion.id, status: "active" },
    });
    if (!asserting) {
      return this.reject(user.pid, feeChain, "unauthorized", new BadRequestException("Unknown or inactive passkey"));
    }

    await this.prisma.chainAccount.update({ where: { id: row.id }, data: { status: "activating" } });
    try {
      const { x, y } = coseToRawXy(Buffer.from(authority.publicKey));
      const authData = fromHexDto(dto.assertion.authenticatorData);
      const clientData = Buffer.from(dto.assertion.clientDataJSON, "base64url");
      const r = fromHexDto(dto.assertion.r);
      const s = fromHexDto(dto.assertion.s);
      const data =
        version === 2
          ? adapter.buildDeployAndInitDataV4({
              salt: adapter.getSalt(user.pid),
              x: new Uint8Array(x),
              y: new Uint8Array(y),
              feePolicyVersion: version,
              maxTotalFee,
              deadline: dto.deadline,
              networkFee,
              authenticatorData: authData,
              clientDataJSON: clientData,
              r,
              s,
            })
          : adapter.buildDeployAndInitDataV3({
              salt: adapter.getSalt(user.pid),
              x: new Uint8Array(x),
              y: new Uint8Array(y),
              feePolicyVersion: version,
              deadline: dto.deadline,
              networkFee,
              authenticatorData: authData,
              clientDataJSON: clientData,
              r,
              s,
            });
      const deploy = await this.broadcastDeploy(chainReference, user.pid, row.address, dto, secret, data);
      if (deploy.resolved) {
        // Resolve-then-act proved OUR deployment without an attributable
        // receipt: mark active, log the resolution, skip receipt-bound records
        // (no fake hashes in the unique txHash column, no false reconcile).
        await this.prisma.chainAccount.update({ where: { id: row.id }, data: { status: "active" } });
        await this.security.log(user.pid, RelayerH1Events.resolveLanded, {
          chain: feeChain,
          entryPoint: "activate",
          unattributed: true,
        });
        return this.viewOf(user, chainReference);
      }
      const receipt = deploy.receipt;
      // Verify the relayer deployed OUR authority (fail closed on mismatch).
      const matches = await this.deploymentMatches(
        await this.rpcFor(chainReference),
        row.address,
        user.pid,
        chainReference,
      ).catch(() => false);
      if (!matches) throw new Error(`evm deploy verification failed: ${receipt.hash}`);
      await this.prisma.chainAccount.update({ where: { id: row.id }, data: { status: "active" } });
      const deployment = await this.chains.deploymentFor(chainReference);
      await this.prisma.transaction
        .create({
          data: {
            pid: user.pid,
            chainAccountId: row.id,
            type: "ACTIVATION",
            amount: networkFee + protocolFee,
            asset: chain.nativeSymbol,
            direction: "out",
            counterparty: deployment?.factory ?? receipt.from,
            chain: "eip155",
            network: chain.name,
            txHash: receipt.hash,
            status: "confirmed",
            confirmedAt: new Date(),
          },
        })
        .catch((err) => this.logger.warn(`evm activation activity record failed: ${(err as Error).message}`));
      await this.security.log(user.pid, "account.evm.activated", {
        txHash: receipt.hash,
        networkFee: networkFee.toString(),
        protocolFee: protocolFee.toString(),
        feePolicyVersion: version,
        maxTotalFee: maxTotalFee.toString(),
      });
      // H2: resolve-then-act outcome for the sponsored activation.
      await this.security.log(user.pid, RelayerH1Events.resolveLanded, {
        chain: feeChain,
        entryPoint: "activate",
        signature: receipt.hash,
      });
      await this.reconcileActivation(user.pid, chainReference, receipt, networkFee, protocolFee, version).catch(
        (err) => this.logger.warn(`evm activation reconcile failed for ${receipt.hash}: ${(err as Error).message}`),
      );
    } catch (err) {
      await this.prisma.chainAccount.update({ where: { id: row.id }, data: { status: "ready" } }).catch(() => undefined);
      throw err;
    }
    return this.viewOf(user, chainReference);
  }

  /**
   * H2 broadcast for EVM activation: claim the (pid, deadline, chain) slot
   * (the deadline is the replay-protection scalar on EVM), then send with
   * resolve-then-act. A duplicate identical retry returns the live view; an
   * ambiguous send resolves via deploymentMatches (deployed ⇒ success, no
   * rebroadcast; not deployed ⇒ ONE identical-bytes rebroadcast; unreadable
   * ⇒ park + alert).
   */
  private async broadcastDeploy(
    chainReference: string,
    pid: string,
    address: string,
    dto: { deadline: number },
    secret: string,
    data: string,
  ): Promise<
    | { resolved: true; receipt: null }
    | { resolved: false; receipt: { hash: string; from: string; costWei: string; l1FeeWei: string } }
  > {
    const slotHash = createHash("sha256").update(data).digest("hex");
    const claim = await this.idempotency.claimSlot(pid, String(dto.deadline), chainReference, slotHash, "activate");
    if (claim.decision === "duplicate") {
      // Identical retry: chain state is the answer — active returns through
      // the resolved path, anything else throws for an explicit retry.
      await this.resolveDeployedView(chainReference, pid);
      return { resolved: true, receipt: null };
    }
    const out = await this.idempotency.broadcastWithResolveThenAct({
      pid,
      nonce: String(dto.deadline),
      chain: chainReference,
      entryPoint: "activate",
      broadcast: () =>
        this.sendDeployTx(chainReference, secret as `0x${string}`, data).then((receipt) => ({
          signature: receipt.hash,
          result: receipt,
        })),
      resolveState: async () => {
        const matches = await this.deploymentMatches(
          await this.rpcFor(chainReference),
          address,
          pid,
          chainReference,
        ).catch(() => null);
        if (matches == null) return { unreadable: true as const };
        return matches
          ? { landed: true as const, signature: claim.signature }
          : { landed: false as const };
      },
    });
    if (!out.result) {
      // Resolved-landed: chain state proves OUR deployment; viewOf re-verifies.
      await this.idempotency.recordOutcome(pid, String(dto.deadline), chainReference, "activate", "resolved-landed");
      await this.resolveDeployedView(chainReference, pid);
      return { resolved: true, receipt: null };
    }
    return { resolved: false, receipt: out.result };
  }

  /**
   * Re-verify a resolved-landed EVM deployment: active returns silently,
   * anything else throws for an explicit retry (never silently dropped).
   */
  private async resolveDeployedView(chainReference: string, pid: string): Promise<void> {
    const view = await this.viewOf({ pid }, chainReference);
    if (view.status !== "active") {
      throw new ServiceUnavailableException(
        "Activation state is unclear — please check the wallet status before retrying",
      );
    }
  }

  /**
   * Post-confirmation reconciliation for EVM activation: verify the contract
   * applied the canonical formula, and the attested network fee tracks the
   * actual receipt cost (execution gas + L1 data fee where the oracle exists).
   */
  private async reconcileActivation(
    pid: string,
    chainReference: string,
    receipt: { hash: string; costWei: string; l1FeeWei?: string },
    networkFee: bigint,
    protocolFee: bigint,
    version: number,
  ): Promise<void> {
    const chain = evmReferenceToFeeChain(chainReference);
    const chainId = Number(chainReference);
    const expectedProtocol =
      version === 2 && Number.isInteger(chainId)
        ? splitEvmFeeV2(networkFee, chainId).protocolFee
        : protocolFeeOf(networkFee, protocolFeeBps(version));
    const l1Fee = receipt.l1FeeWei != null ? BigInt(receipt.l1FeeWei) : 0n;
    const actual = BigInt(receipt.costWei) + l1Fee;
    const absorbed = absorbedLoss(networkFee, actual);
    const overAttested = exceedsDriftBound(networkFee, actual);
    await this.security.log(pid, "account.evm.activation.reconciled", {
      txHash: receipt.hash,
      networkFee: networkFee.toString(),
      protocolFee: protocolFee.toString(),
      protocolFeeExpected: expectedProtocol.toString(),
      actualNetworkFee: actual.toString(),
      relayerAbsorbed: absorbed.toString(),
      overAttested,
    });
    // H1.iv: per-tx relayer P&L, dashboarded per chain + entry point.
    await this.security.log(pid, RelayerH1Events.pnl, {
      chain,
      entryPoint: "activate",
      signature: receipt.hash,
      absorbed: fmtBaseUnits(absorbed),
      attested: fmtBaseUnits(networkFee),
      actual: fmtBaseUnits(actual),
    });
    // H3: absorbed losses feed the per-chain spend-rate breaker.
    await this.breaker.recordAbsorbed(pid, chain, absorbed).catch((err) =>
      this.logger.warn(`breaker record failed: ${(err as Error).message}`),
    );
    if (protocolFee !== expectedProtocol) {
      // H1.iii: formula divergence — alert, never rebroadcast.
      await this.security.log(pid, RelayerH1Events.formulaMismatch, {
        chain,
        entryPoint: "activate",
        signature: receipt.hash,
        attested: fmtBaseUnits(networkFee),
        actual: fmtBaseUnits(actual),
        expected: fmtBaseUnits(expectedProtocol),
        absorbed: fmtBaseUnits(absorbed),
      });
      this.logger.error(
        `evm activation formula anomaly: ${receipt.hash} protocol=${protocolFee} expected=${expectedProtocol}`,
      );
    }
    if (overAttested) {
      // H1.iii: attested fee exceeded the drift bound over the actual charge.
      await this.security.log(pid, RelayerH1Events.overAttested, {
        chain,
        entryPoint: "activate",
        signature: receipt.hash,
        attested: fmtBaseUnits(networkFee),
        actual: fmtBaseUnits(actual),
        expected: fmtBaseUnits(actual),
        absorbed: fmtBaseUnits(absorbed),
      });
      this.logger.error(
        `evm activation over-attestation anomaly: ${receipt.hash} attested=${networkFee} actual=${actual}`,
      );
    }
    // H3: feed the rolling absorbed-loss window (opens the breaker on breach).
    await this.breaker.recordAbsorbed(pid, chain, absorbed).catch((err) =>
      this.logger.warn(`breaker record failed: ${(err as Error).message}`),
    );
  }

  private async ownedRow(pid: string, chain: Pick<RegistryChain, "id" | "reference">) {
    const row = await this.prisma.chainAccount.findFirst({
      where: { chainId: chain.id, accountType: ACCOUNT_TYPE, pid },
    });
    if (!row) throw new NotFoundException("Account not found");
    return row;
  }

  /** Lazy viem import (keeps the ESM graph out of Jest unless a deploy runs). */
  private async sendDeployTx(
    chainReference: string,
    secret: `0x${string}`,
    data: string,
  ): Promise<{ hash: string; from: string; costWei: string; l1FeeWei: string }> {
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
    const l1Fee = await this.l1DataFeeWei(chainReference, hash);
    return { hash, from: account.address, costWei: (receipt.gasUsed * gasPrice).toString(), l1FeeWei: l1Fee.toString() };
  }
}

/** Hex (`0x`-prefixed or bare) → bytes. */
function fromHexDto(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new BadRequestException("Invalid hex bytes");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
