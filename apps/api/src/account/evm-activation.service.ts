// EVM counterfactual activation (mirrors activation.service.ts state machine).
//
// The address exists before deployment: users can fund it, anyone can observe it,
// and the Peridot relayer deploys (`deployAndInit`) once it is READY. Status rows
// never carry wei balances (they overflow the int64 columns) — `viewOf` reads
// chain state live and returns wei as strings.

import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ChainAccountStatus } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { EvmAdapter, EvmRpc, buildViewCalldata, fromAscii, keccak256, toHex } from "@peridotvault/pid-evm";
import { ChainRegistryService, type RegistryChain } from "../chain/chain-registry.service";
import { classifyActivation, requireActiveAuthority } from "../common/activation";
import { ACCOUNT_TYPE_SMART, EIP155_NAMESPACE } from "../common/chains";
import {
  protocolFeeBps,
  protocolFeeOf,
  exceedsDriftBound,
  MAX_TTL_SECS,
} from "../common/solana-relay";
import { coseToRawXy } from "../credentials/cose";
import { PID_EVM_POLL_MS } from "../common/app-config";
import { FeePolicyService } from "../fee/fee-policy.service";
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
  /**
   * service fee, separated from the network fee for wallet rendering
   * (ANT-743: pure `networkFee × bps / 10_000`, no minima) in wei. Canonical
   * alias of the protocol-fee leg — `serviceFee`, `platformFee` (SVM quotes),
   * and `protocolFee` name the same value.
   */
  serviceFeeWei: string;
  /** minima leg — always "0" since ANT-743 (kept for shape compatibility). */
  chainMinBaseUnits: string;
  /** Canonical alias of networkFeeWei (base units, decimal string). */
  networkFee: string;
  /** Canonical alias of serviceFeeWei (base units, decimal string). */
  platformFee: string;
  /** Canonical alias of totalFeeWei (base units, decimal string). */
  totalFee: string;
  /** Canonical alias of maxTotalFeeWei (base units, decimal string). */
  maxTotalFee: string;
  /** Present on submit results when the signed version trails the active policy by one (NFR-6). */
  feePolicyWarning?: string;
  /**
   * WS1 §7.1 lazy-activation quote extension (always present so clients never
   * branch on versions). `required` is server-decided from chain state —
   * a client `isFirstAction` hint is never trusted. `mode: "evm-sequenced"`
   * means the relayer runs `deployAndInit` → `execute` back-to-back in one
   * user intent; `"none"` means the account is ACTIVE (zero behavior change).
   */
  activation: {
    required: boolean;
    includedInTotal: boolean;
    /** Deploy-leg network estimate (wei) — `"0"` when no activation is required. */
    estimateWei: string;
    /** How the estimate was derived (gas table row × per-chain RPC gasPrice). */
    estimateBasis: string;
    mode: "evm-sequenced" | "none";
  };
}

const ACCOUNT_TYPE = ACCOUNT_TYPE_SMART;

/** `nonce()` selector (read-only account nonce for execute-leg idempotency). */
const NONCE_SELECTOR = "0x" + toHex(keccak256(fromAscii("nonce()")).subarray(0, 4));

/** WS1 §7.3 error code for an in-flight deploy/composite (client polls, never resubmits). */
export const ACTIVATION_IN_PROGRESS = "ActivationInProgress";

export interface EvmFirstActionResult {
  activation: EvmActivationView;
  /** Relayer-submitted first `execute` hash (sequenced right after deploy). */
  executeTxHash: string;
  /** Idempotency key correlating deploy + execute (client uuid or server-generated). */
  firstActionId: string;
  mode: "evm-sequenced";
}
/**
 * WS1 §5 (interim, decided in spec): per-chain `deployAndInit` gas table.
 * Every row is 350k today ("measured ~250k + V3 assertion calldata" headroom
 * preserved); the shape is per-chain NOW so the WS2 exit-criteria calibration
 * (Reid P50/P95, n≥30/chain → `P95 + 20%` per row) lands as data, not code.
 * Unknown references fall back to the default row (same 350k) — deploy only
 * runs for registered chains (`chainOrThrow`), so the fallback only serves
 * quotes, never settlement. GasAnomaly (2× full frame, factory) stays the
 * drift-reject backstop above every row.
 */
export const DEPLOY_GAS_ESTIMATE: Readonly<Record<string, bigint>> = Object.freeze({
  "97": 350_000n, // BSC testnet
  "10143": 350_000n, // Monad testnet
  "421614": 350_000n, // Arbitrum Sepolia
  "84532": 350_000n, // Base Sepolia
});
export const DEPLOY_GAS_ESTIMATE_DEFAULT = 350_000n;

/** Gas row for a chain reference (interim: uniform 350k, see table note). */
export function deployGasEstimateFor(chainReference: string): bigint {
  return DEPLOY_GAS_ESTIMATE[chainReference] ?? DEPLOY_GAS_ESTIMATE_DEFAULT;
}
/**
 * WS1 §5.3: L1 data-fee pre-flight quoter for OP-Stack chains (Base/Arbitrum
 * Sepolia). OFF on testnet — the relayer absorbs L1 fees and records them in
 * the subsidy ledger (`reconcileActivation`); mainnet MUST enable this and
 * fold the quote into the user-approved total (reconciliation rule §4.3).
 */
const EVM_L1_QUOTE_ENABLED = false;
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
    @Optional() private readonly fees?: FeePolicyService,
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
    // EVM canonical is policy 2 (pure 50%, no floor). Policy 1 stays
    // accepted on submit for sunset (frozen semantics: 50% no floor).
    return 2;
  }

  /** Active quoting version (DB-first via the fee-policy service, frozen 2 fallback). */
  private async activeVersion(): Promise<number> {
    const policy = await this.fees?.activePolicy().catch(() => undefined);
    return policy?.version ?? this.policyVersion();
  }

  /** H1.ii: semantic intent rejections emit intent.rejected (EVM intents carry no nonce — key omitted). */
  private async reject(
    pid: string,
    chain: FeeChain | "unknown",
    cause: IntentRejectionCause,
    err: Error,
    entryPoint = "activate",
  ): Promise<never> {
    await this.security.log(pid, RelayerH1Events.intentRejected, {
      chain,
      entryPoint,
      cause,
    });
    throw err;
  }

  /**
   * Service (protocol) fee for a policy version (ANT-743: pure percentage —
   * `networkFee × bps / 10_000`, no minima on any path). DB-first for the
   * version's bps; the fee-service minima leg is always 0 and ignored. Absent
   * service/row falls back to the frozen bps legs. Submit paths settle under
   * the SIGNED version, so v1 traffic keeps v1 math.
   */
  private async serviceFeeFor(
    networkFee: bigint,
    version: number,
    chainReference: string,
  ): Promise<{ serviceFee: bigint; chainMin: bigint; bps: number }> {
    const leg = await this.fees?.minFeeForVersion(EIP155_NAMESPACE, chainReference, version).catch(() => undefined);
    void chainReference;
    if (leg) return { serviceFee: protocolFeeOf(networkFee, leg.bps), chainMin: 0n, bps: leg.bps };
    if (version === 1 || version === 2) {
      const bps = protocolFeeBps(version);
      return { serviceFee: protocolFeeOf(networkFee, bps), chainMin: 0n, bps };
    }
    throw new BadRequestException("Unsupported fee policy — re-quote and try again");
  }

  /** Realtime network-cost estimate for the deploy (no margin — the protocol fee is separate).
   *  Gas row is per-chain (WS1 §5 table); gasPrice is per-chain RPC (never
   *  crossed between chains); 1 gwei fallback when the node hides the price. */
  private async networkFeeWei(chainReference: string): Promise<bigint> {
    const rpc = await this.rpcFor(chainReference);
    const gasPrice = await rpc.gasPrice().catch(() => 1_000_000_000n);
    return deployGasEstimateFor(chainReference) * gasPrice;
  }

  /** Gas row × live gasPrice behind the current deploy quote (for `estimateBasis`). */
  private async deployQuoteParts(chainReference: string): Promise<{ gas: bigint; gasPrice: bigint; networkFee: bigint }> {
    const rpc = await this.rpcFor(chainReference);
    const gasPrice = await rpc.gasPrice().catch(() => 1_000_000_000n);
    const gas = deployGasEstimateFor(chainReference);
    return { gas, gasPrice, networkFee: gas * gasPrice };
  }

  /**
   * L1 data-fee QUOTE for a prospective tx input (WS1 §5.3, behind
   * `EVM_L1_QUOTE_ENABLED`). Testnet returns 0 (relayer absorbs + ledgers);
   * mainnet callers must pass the exact factory/input bytes so the oracle
   * prices what will actually land. Best-effort: no oracle → 0.
   */
  private async l1DataFeeQuoteWei(chainReference: string, inputHex: string): Promise<bigint> {
    if (!EVM_L1_QUOTE_ENABLED) return 0n;
    try {
      const rpc = await this.rpcFor(chainReference);
      const input = (inputHex.startsWith("0x") ? inputHex.slice(2) : inputHex) as string;
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
          const version = await this.activeVersion();
          const { serviceFee } = await this.serviceFeeFor(networkFee, version, ca.chain.reference);
          const required = networkFee + serviceFee;
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
    const { gas, gasPrice, networkFee } = await this.deployQuoteParts(chainReference).catch(() => ({
      gas: deployGasEstimateFor(chainReference),
      gasPrice: 0n,
      networkFee: 0n,
    }));
    const version = await this.activeVersion();
    const {
      serviceFee: protocolFee,
      chainMin,
      bps,
    } = await this.serviceFeeFor(networkFee, version, chainReference);
    const totalFee = networkFee + protocolFee;
    const isActive = deployed && (await this.deploymentMatches(rpc, row.address, user.pid, chainReference).catch(() => false));
    const status = isActive ? "active" : this.classify(balance, totalFee, row.status);
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
      protocolFeeBps: bps,
      feePolicyVersion: version,
      totalFeeWei: totalFee.toString(),
      maxTotalFeeWei: totalFee.toString(),
      serviceFeeWei: protocolFee.toString(),
      chainMinBaseUnits: chainMin.toString(),
      // Canonical aliases (same values, wallet-friendly names shared with SVM quotes).
      networkFee: networkFee.toString(),
      platformFee: protocolFee.toString(),
      totalFee: totalFee.toString(),
      maxTotalFee: totalFee.toString(),
      activation: isActive
        ? { required: false, includedInTotal: false, estimateWei: "0", estimateBasis: "account-active", mode: "none" as const }
        : {
            required: true,
            // The deploy leg settles inside the quoted total (single user
            // approval covers deploy + first execute — WS1 §3.1 sequenced).
            includedInTotal: true,
            estimateWei: networkFee.toString(),
            estimateBasis: `DEPLOY_GAS_ESTIMATE[${chainReference}]=${gas} x gasPrice=${gasPrice}wei`,
            mode: "evm-sequenced" as const,
          },
    };
  }

  /**
   * Deploy the counterfactual via the Peridot relayer (V4 `deployAndInitV4`
   * only — ANT-895/B2 closes V3 broadcasts). The user's
   * assertion binds salt, authority, policy, maxTotalFee, deadline,
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
      /** WS1 §7.2 idempotency key (client uuid). Echoed in errors/logs; a
       *  retry with the same id never deploys twice (active → no-op view,
       *  in-flight → ActivationInProgress 409). */
      firstActionId?: string;
      assertion: { id: string; r: string; s: string; authenticatorData: string; clientDataJSON: string };
    },
  ): Promise<EvmActivationView> {
    const chain = await this.chainOrThrow(chainReference);
    const row = await this.ownedRow(user.pid, chain);
    // FeeChain for every H1/H2/H3 row on this path (unknown testnets bucket to 'unknown').
    const feeChain = evmReferenceToFeeChain(chain.reference);
    const adapter = await this.adapterFor(chainReference);
    const firstActionId = dto.firstActionId;

    const live = await this.viewOf(user, chainReference);
    // Idempotent no-op: an ACTIVE account returns its live view without
    // touching the chain (safe to retry createAccount/activate freely).
    if (live.status === "active") return live;
    if (live.status === "activating") {
      // WS1 §7.3 ActivationInProgress: a deploy is already in flight for this
      // account — the client polls status instead of resubmitting.
      throw new ConflictException({
        code: ACTIVATION_IN_PROGRESS,
        message: "Activation already in progress — check the wallet status instead of resubmitting",
        ...(firstActionId ? { firstActionId } : {}),
        retryable: true,
      });
    }
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

    // Submit-time version gate (ANT-730, spec §4.3/NFR-6): the active version
    // and one version back are accepted (the older with a warning — v1 sunset
    // keeps frozen 50%-no-floor math); anything older is StaleQuote (410),
    // anything unknown is UnknownFeePolicy (400). Without the fee service the
    // frozen {1,2} set applies (previous behavior).
    const version = dto.feePolicyVersion;
    let feePolicyWarning: string | undefined;
    if (this.fees) {
      const gate = await this.fees.checkSubmitVersion(version);
      if (!gate.ok) {
        return this.reject(
          user.pid,
          feeChain,
          "policy-unknown",
          gate.status === 410
            ? new GoneException({ code: gate.code, message: gate.message })
            : new BadRequestException({ code: gate.code, message: gate.message }),
        );
      }
      feePolicyWarning = gate.warning;
    } else if (version !== 1 && version !== 2) {
      return this.reject(user.pid, feeChain, "policy-unknown", new BadRequestException("Unsupported fee policy — re-quote and try again"));
    }
    // ANT-895/B2: V3 fee paths are disabled on-chain (V3Deprecated) — the
    // relayer never broadcasts V3 calldata. Policy 1 (V3 sunset) is rejected
    // fail-closed even when the fee-service gate would accept it; clients
    // must re-quote under policy 2 (V4).
    if (version !== 2) {
      return this.reject(
        user.pid,
        feeChain,
        "policy-unknown",
        new BadRequestException("Fee policy 1 is sunset — re-quote and try again"),
      );
    }
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
    const {
      serviceFee: protocolFee,
      chainMin,
      bps,
    } = await this.serviceFeeFor(networkFee, version, chainReference);
    const totalFee = networkFee + protocolFee;
    // V4 B6: VERIFY the user-approved bound. total > max reverts on-chain
    // (FeeExceedsMax) — fail closed here before broadcast. The bound is
    // required on every submit (V3 sunset has no bound to verify).
    if (dto.maxTotalFeeWei == null) {
      return this.reject(user.pid, feeChain, "policy-unknown", new BadRequestException("maxTotalFeeWei is required — re-quote and try again"));
    }
    const maxTotalFee = BigInt(dto.maxTotalFeeWei);
    if (totalFee > maxTotalFee) {
      await this.security.log(user.pid, RelayerH1Events.driftRejected, {
        chain: feeChain,
        entryPoint: "activate",
        quoted: fmtBaseUnits(maxTotalFee),
        attested: fmtBaseUnits(totalFee),
      });
      return this.reject(user.pid, feeChain, "drift", new ConflictException("Network fee exceeds maxTotalFee — re-quote and try again"));
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
      const data = adapter.buildDeployAndInitDataV4({
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
        const resolved = await this.viewOf(user, chainReference);
        return feePolicyWarning ? { ...resolved, feePolicyWarning } : resolved;
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
        ...(firstActionId ? { firstActionId } : {}),
      });
      // H2: resolve-then-act outcome for the sponsored activation.
      await this.security.log(user.pid, RelayerH1Events.resolveLanded, {
        chain: feeChain,
        entryPoint: "activate",
        signature: receipt.hash,
      });
      await this.reconcileActivation(
        user.pid,
        chainReference,
        receipt,
        networkFee,
        protocolFee,
        {
          version,
          bps,
          chainMin,
        },
        firstActionId,
      ).catch((err) => this.logger.warn(`evm activation reconcile failed for ${receipt.hash}: ${(err as Error).message}`));
      // NFR-4/AC-13: every activation lands a quote–actual pair in the subsidy
      // ledger (quoted submit attestation vs execution gas + L1 data fee).
      // Best-effort — a ledger write failure never fails the user flow.
      await this.fees
        ?.recordSubsidy({
          pid: user.pid,
          namespace: EIP155_NAMESPACE,
          reference: chainReference,
          kind: "activation",
          quotedFee: networkFee + protocolFee,
          actualCost: BigInt(receipt.costWei) + (receipt.l1FeeWei != null ? BigInt(receipt.l1FeeWei) : 0n),
          txHash: receipt.hash,
        })
        .catch((err) => this.logger.warn(`evm subsidy ledger failed for ${receipt.hash}: ${(err as Error).message}`));
    } catch (err) {
      await this.prisma.chainAccount.update({ where: { id: row.id }, data: { status: "ready" } }).catch(() => undefined);
      throw err;
    }
    const view = await this.viewOf(user, chainReference);
    return feePolicyWarning ? { ...view, feePolicyWarning } : view;
  }

  /**
   * WS1 §3.1 lazy first-action (EVM): `deployAndInit` → `execute` back-to-back
   * in ONE user intent (one approval, two on-chain txs, no separate activate
   * step). The deploy leg reuses `activate()` (idempotent no-op when ACTIVE);
   * the execute leg runs through the same relayer key with its own
   * user-signed execute authorization, drift bound, and H2 slot. Correlated
   * end-to-end by `firstActionId` (AC-16: a retry with the same id never
   * deploys nor executes twice).
   */
  async activateAndExecute(
    user: { pid: string },
    chainReference: string,
    dto: {
      firstActionId?: string;
      activation: {
        quotedNetworkFeeWei: string;
        feePolicyVersion: number;
        maxTotalFeeWei?: string;
        deadline: number;
        assertion: { id: string; r: string; s: string; authenticatorData: string; clientDataJSON: string };
      };
      execute: {
        to: string;
        value: string;
        data: string;
        deadline: number;
        feePolicyVersion: number;
        maxTotalFeeWei?: string;
        quotedNetworkFeeWei: string;
        assertion: { id: string; r: string; s: string; authenticatorData: string; clientDataJSON: string };
      };
    },
  ): Promise<EvmFirstActionResult> {
    const firstActionId = dto.firstActionId ?? randomUUID();
    const live = await this.viewOf(user, chainReference);
    if (live.status === "activating") {
      throw new ConflictException({
        code: ACTIVATION_IN_PROGRESS,
        message: "Activation already in progress — check the wallet status instead of resubmitting",
        firstActionId,
        retryable: true,
      });
    }
    // Deploy leg: no-op view when already ACTIVE, deploys when READY, throws
    // on any other state (same gates as the standalone path — never two).
    const activation = await this.activate(user, chainReference, { ...dto.activation, firstActionId });
    if (activation.status !== "active") {
      throw new ServiceUnavailableException("Activation did not complete — check the wallet status before retrying");
    }
    const exec = await this.relayExecute(user, chainReference, activation.smartAccountAddress, dto.execute, firstActionId);
    await this.security.log(user.pid, "account.evm.firstAction.completed", {
      chain: evmReferenceToFeeChain(chainReference),
      entryPoint: "first-action",
      firstActionId,
      deployFeePolicyVersion: dto.activation.feePolicyVersion,
      executeTxHash: exec.hash,
      executeNetworkFee: exec.networkFee.toString(),
      executeProtocolFee: exec.protocolFee.toString(),
    });
    return { activation, executeTxHash: exec.hash, firstActionId, mode: "evm-sequenced" };
  }

  /**
   * Execute leg of a lazy first-action: relay ONE user-signed `execute`
   * through the account. The caller guarantees the account is ACTIVE (freshly
   * deployed above or pre-existing). Reentrancy-safe (nonReentrant on-chain),
   * checks-effects-interactions ordered, H2-slotted per (pid, deadline,
   * chain, "execute") so an identical retry returns the same hash.
   */
  private async relayExecute(
    user: { pid: string },
    chainReference: string,
    accountAddress: string,
    dto: {
      to: string;
      value: string;
      data: string;
      deadline: number;
      feePolicyVersion: number;
      maxTotalFeeWei?: string;
      quotedNetworkFeeWei: string;
      assertion: { id: string; r: string; s: string; authenticatorData: string; clientDataJSON: string };
    },
    firstActionId: string,
  ): Promise<{ hash: string; networkFee: bigint; protocolFee: bigint }> {
    const chain = await this.chainOrThrow(chainReference);
    const feeChain = evmReferenceToFeeChain(chain.reference);
    const adapter = await this.adapterFor(chainReference);
    await this.breaker.requireClosed(chainReference, "execute");

    const version = dto.feePolicyVersion;
    // ANT-895/B2: V3 `execute` is disabled on-chain (V3Deprecated) — the
    // relayer never broadcasts V3 calldata. Policy 1 is rejected fail-closed;
    // clients must re-quote under policy 2 (V4).
    if (version !== 2) {
      return this.reject(user.pid, feeChain, "policy-unknown", new BadRequestException("Fee policy 1 is sunset — re-quote and try again"), "execute");
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(dto.to)) {
      return this.reject(user.pid, feeChain, "policy-unknown", new BadRequestException("Invalid execute target"), "execute");
    }
    if (!/^\d+$/.test(dto.value)) {
      return this.reject(user.pid, feeChain, "policy-unknown", new BadRequestException("Invalid execute value"), "execute");
    }
    const value = BigInt(dto.value);
    const data = fromHexDto(dto.data);
    if (data.length > 10_240) {
      return this.reject(user.pid, feeChain, "policy-unknown", new BadRequestException("Execute calldata exceeds 10_240 bytes"), "execute");
    }
    const rpc = await this.rpcFor(chainReference);
    const now = await rpc.blockTimestamp().catch(() => Math.floor(Date.now() / 1000));
    if (dto.deadline <= now) {
      return this.reject(user.pid, feeChain, "expired", new BadRequestException("Authorization expired — please try again"), "execute");
    }
    if (dto.deadline - now > MAX_TTL_SECS) {
      return this.reject(user.pid, feeChain, "expired", new BadRequestException("Authorization lifetime exceeds 600 seconds — re-quote and try again"), "execute");
    }
    const asserting = await this.prisma.authority.findFirst({
      where: { pid: user.pid, credentialId: dto.assertion.id, status: "active" },
    });
    if (!asserting) {
      return this.reject(user.pid, feeChain, "unauthorized", new BadRequestException("Unknown or inactive passkey"), "execute");
    }
    const secret = await this.chains.relayerSecretFor(chainReference);
    if (!secret || !/^0x[0-9a-fA-F]{64}$/.test(secret)) {
      throw new ServiceUnavailableException(
        "EVM auto-deploy is not configured — deploy with contracts/evm (script/Deploy.s.sol) then retry.",
      );
    }

    // Attest the execute network fee at submit: exact node estimate (not the
    // deploy table — execute cost varies per call). Calldata length is fee
    // invariant (fixed ABI widths), so estimating with a zero-fee draft is exact.
    const authData = fromHexDto(dto.assertion.authenticatorData);
    const clientData = Buffer.from(dto.assertion.clientDataJSON, "base64url");
    const r = fromHexDto(dto.assertion.r);
    const s = fromHexDto(dto.assertion.s);
    const draftData = adapter.buildExecuteDataV4({
      to: dto.to, value, data, deadline: dto.deadline, feePolicyVersion: version,
      maxTotalFee: 0n, networkFee: 0n, authenticatorData: authData, clientDataJSON: clientData, r, s,
    });
    const gasPrice = await rpc.gasPrice().catch(() => 1_000_000_000n);
    const estGas = await this.estimateTxGas(chainReference, accountAddress, draftData);
    const networkFee = estGas * gasPrice;
    const quoted = BigInt(dto.quotedNetworkFeeWei);
    if (exceedsDriftBound(networkFee, quoted)) {
      await this.security.log(user.pid, RelayerH1Events.driftRejected, {
        chain: feeChain,
        entryPoint: "execute",
        quoted: fmtBaseUnits(quoted),
        attested: fmtBaseUnits(networkFee),
      });
      return this.reject(user.pid, feeChain, "drift", new ConflictException("Network fee moved — re-quote and try again"), "execute");
    }
    const { serviceFee: protocolFee } = await this.serviceFeeFor(networkFee, version, chainReference);
    const totalFee = networkFee + protocolFee;
    // V4 B6: the user-approved bound is required on every execute submit.
    if (dto.maxTotalFeeWei == null) {
      return this.reject(user.pid, feeChain, "policy-unknown", new BadRequestException("maxTotalFeeWei is required — re-quote and try again"), "execute");
    }
    const maxTotalFee = BigInt(dto.maxTotalFeeWei);
    if (totalFee > maxTotalFee) {
      await this.security.log(user.pid, RelayerH1Events.driftRejected, {
        chain: feeChain,
        entryPoint: "execute",
        quoted: fmtBaseUnits(maxTotalFee),
        attested: fmtBaseUnits(totalFee),
      });
      return this.reject(user.pid, feeChain, "drift", new ConflictException("Network fee exceeds maxTotalFee — re-quote and try again"), "execute");
    }
    // ANT-800/ANT-895: V4-only execute calldata. The assertion is
    // passkey-signed over the V4 payload (binds maxTotalFee); broadcasting
    // it through V3 calldata would drop the user-approved bound (and V3 is
    // disabled on-chain post-B2).
    const execData = adapter.buildExecuteDataV4({
      to: dto.to,
      value,
      data,
      deadline: dto.deadline,
      feePolicyVersion: version,
      maxTotalFee,
      networkFee,
      authenticatorData: authData,
      clientDataJSON: clientData,
      r,
      s,
    });
    const exec = await this.broadcastExecute(chainReference, user.pid, accountAddress, dto, secret, execData);
    if (exec.resolved) {
      if (!exec.signature) {
        throw new ServiceUnavailableException("Execute outcome is unclear — check the wallet status before retrying");
      }
      return { hash: exec.signature, networkFee, protocolFee };
    }
    const receipt = exec.receipt;
    await this.prisma.transaction
      .create({
        data: {
          pid: user.pid,
          chainAccountId: (await this.ownedRow(user.pid, chain)).id,
          type: "EXECUTE",
          amount: value + networkFee + protocolFee,
          asset: chain.nativeSymbol,
          direction: "out",
          counterparty: dto.to,
          chain: "eip155",
          network: chain.name,
          txHash: receipt.hash,
          status: "confirmed",
          confirmedAt: new Date(),
        },
      })
      .catch((err) => this.logger.warn(`evm execute activity record failed: ${(err as Error).message}`));
    await this.security.log(user.pid, "account.evm.executed", {
      txHash: receipt.hash,
      to: dto.to,
      value: value.toString(),
      networkFee: networkFee.toString(),
      protocolFee: protocolFee.toString(),
      feePolicyVersion: version,
      maxTotalFee: maxTotalFee.toString(),
      firstActionId,
    });
    await this.reconcileExecute(user.pid, chainReference, receipt, networkFee, protocolFee, version, firstActionId).catch(
      (err) => this.logger.warn(`evm execute reconcile failed for ${receipt.hash}: ${(err as Error).message}`),
    );
    return { hash: receipt.hash, networkFee, protocolFee };
  }

  /**
   * Post-confirmation reconciliation for the execute leg: same subsidy-ledger
   * shape as activation (quoted vs actual incl. L1), feeding the breaker P&L.
   * Every first-action therefore leaves TWO quoted-vs-actual pairs (NFR-4).
   */
  private async reconcileExecute(
    pid: string,
    chainReference: string,
    receipt: { hash: string; costWei: string; l1FeeWei?: string },
    networkFee: bigint,
    protocolFee: bigint,
    version: number,
    firstActionId: string,
  ): Promise<void> {
    const chain = evmReferenceToFeeChain(chainReference);
    // ANT-743: pure percentage on every version (no floors) — the expected
    // leg is `networkFee × bps / 10_000`, matching `serviceFeeFor` at submit.
    const expectedProtocol = protocolFeeOf(networkFee, protocolFeeBps(version));
    const l1Fee = receipt.l1FeeWei != null ? BigInt(receipt.l1FeeWei) : 0n;
    const actual = BigInt(receipt.costWei) + l1Fee;
    const absorbed = absorbedLoss(networkFee, actual);
    const overAttested = exceedsDriftBound(networkFee, actual);
    await this.security.log(pid, "account.evm.execute.reconciled", {
      txHash: receipt.hash,
      networkFee: networkFee.toString(),
      protocolFee: protocolFee.toString(),
      protocolFeeExpected: expectedProtocol.toString(),
      actualNetworkFee: actual.toString(),
      relayerAbsorbed: absorbed.toString(),
      overAttested,
      firstActionId,
    });
    await this.security.log(pid, RelayerH1Events.pnl, {
      chain,
      entryPoint: "execute",
      signature: receipt.hash,
      absorbed: fmtBaseUnits(absorbed),
      attested: fmtBaseUnits(networkFee),
      actual: fmtBaseUnits(actual),
    });
    await this.breaker.recordAbsorbed(pid, chain, absorbed).catch((err) =>
      this.logger.warn(`breaker record failed: ${(err as Error).message}`),
    );
    if (protocolFee !== expectedProtocol) {
      await this.security.log(pid, RelayerH1Events.formulaMismatch, {
        chain,
        entryPoint: "execute",
        signature: receipt.hash,
        attested: fmtBaseUnits(networkFee),
        actual: fmtBaseUnits(actual),
        expected: fmtBaseUnits(expectedProtocol),
        absorbed: fmtBaseUnits(absorbed),
      });
      this.logger.error(
        `evm execute formula anomaly: ${receipt.hash} protocol=${protocolFee} expected=${expectedProtocol}`,
      );
    }
    if (overAttested) {
      await this.security.log(pid, RelayerH1Events.overAttested, {
        chain,
        entryPoint: "execute",
        signature: receipt.hash,
        attested: fmtBaseUnits(networkFee),
        actual: fmtBaseUnits(actual),
        expected: fmtBaseUnits(actual),
        absorbed: fmtBaseUnits(absorbed),
      });
      this.logger.error(
        `evm execute over-attestation anomaly: ${receipt.hash} attested=${networkFee} actual=${actual}`,
      );
    }
  }

  /**
   * H2 broadcast for the execute leg: claim the (pid, deadline, chain,
   * "execute") slot, then send with resolve-then-act against the account
   * nonce. A duplicate identical retry returns the prior signature (no second
   * execution — on-chain nonce + slot forbid it); a claimed-but-never-sent
   * slot on a freshly-deployed (nonce-0) account is safe to broadcast once.
   */
  private async broadcastExecute(
    chainReference: string,
    pid: string,
    accountAddress: string,
    dto: { deadline: number },
    secret: string,
    data: string,
  ): Promise<
    | { resolved: true; signature: string | null }
    | { resolved: false; receipt: { hash: string; from: string; costWei: string; l1FeeWei: string } }
  > {
    const rpc = await this.rpcFor(chainReference);
    const nonceBefore = await this.accountNonce(rpc, accountAddress).catch(() => null);
    const slotHash = createHash("sha256").update(data).digest("hex");
    const claim = await this.idempotency.claimSlot(pid, String(dto.deadline), chainReference, slotHash, "execute");
    if (claim.decision === "duplicate") {
      if (claim.signature) return { resolved: true, signature: claim.signature };
      // Claimed but never submitted: only a freshly-deployed account (nonce
      // still 0, baseline known) is safe to broadcast; anything else parks.
      const nonceNow = await this.accountNonce(rpc, accountAddress).catch(() => null);
      if (nonceBefore === 0n && nonceNow === 0n) {
        this.logger.warn(`evm execute slot claimed-but-unsubmitted, rebroadcasting once: pid deadline=${dto.deadline}`);
      } else {
        throw new ServiceUnavailableException(
          "Execute may still be confirming — check the wallet status before retrying",
        );
      }
    }
    const out = await this.idempotency.broadcastWithResolveThenAct({
      pid,
      nonce: String(dto.deadline),
      chain: chainReference,
      entryPoint: "execute",
      broadcast: () =>
        this.sendExecuteTx(chainReference, secret as `0x${string}`, accountAddress, data).then((receipt) => ({
          signature: receipt.hash,
          result: receipt,
        })),
      resolveState: async () => {
        const n = await this.accountNonce(rpc, accountAddress).catch(() => null);
        if (n == null || nonceBefore == null) return { unreadable: true as const };
        return n > nonceBefore
          ? { landed: true as const, signature: claim.signature }
          : { landed: false as const };
      },
    });
    if (!out.result) {
      await this.idempotency.recordOutcome(pid, String(dto.deadline), chainReference, "execute", "resolved-landed");
      return { resolved: true, signature: out.signature };
    }
    return { resolved: false, receipt: out.result };
  }

  /** Read-only account nonce (`nonce()` view; null-friendly for resolve paths). */
  private async accountNonce(rpc: EvmRpc, accountAddress: string): Promise<bigint> {
    const res = await rpc.call<string>("eth_call", [{ to: accountAddress, data: NONCE_SELECTOR }, "latest"]);
    return BigInt(res);
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
    leg: { version: number; bps: number; chainMin: bigint },
    firstActionId?: string,
  ): Promise<void> {
    const chain = evmReferenceToFeeChain(chainReference);
    const expectedProtocol = protocolFeeOf(networkFee, leg.bps);
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
      ...(firstActionId ? { firstActionId } : {}),
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
    const deployment = await this.chains.deploymentFor(chainReference);
    if (!deployment) throw new ServiceUnavailableException("EVM accounts are not configured yet");
    return this.sendRelayerTx(chainReference, secret, deployment.factory, data);
  }

  /** Execute-leg send: same relayer key, same receipt shape, target = the account. */
  private async sendExecuteTx(
    chainReference: string,
    secret: `0x${string}`,
    accountAddress: string,
    data: string,
  ): Promise<{ hash: string; from: string; costWei: string; l1FeeWei: string }> {
    return this.sendRelayerTx(chainReference, secret, accountAddress, data);
  }

  /** Node gas estimate for an attested submit (execute leg; deploy uses the §5 table). */
  private async estimateTxGas(chainReference: string, to: string, data: string): Promise<bigint> {
    const url = await this.chains.rpcUrlForReference(chainReference);
    const viem = (await import("viem")) as typeof import("viem");
    const publicClient = viem.createPublicClient({ transport: viem.http(url) });
    return publicClient.estimateGas({ to: to as `0x${string}`, data: data as `0x${string}` });
  }

  /** Shared relayer submission (deploy + execute legs): estimate, send, confirm, price. */
  private async sendRelayerTx(
    chainReference: string,
    secret: `0x${string}`,
    to: string,
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
    const gas = await publicClient.estimateGas({ to: to as `0x${string}`, data: data as `0x${string}` });
    const hash = await walletClient.sendTransaction({ to: to as `0x${string}`, data: data as `0x${string}`, gas });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`evm tx reverted: ${hash}`);
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
