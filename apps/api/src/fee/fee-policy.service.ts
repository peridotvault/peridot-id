// Chain fee-policy v2 — DB-managed MIN_FEE per chain (ANT-730, spec ANT-727 §4).
//
// Quote-time source of truth for `serviceFee = max(networkFee × bps / 10_000,
// MIN_FEE[chain])`. Reads are DB-first with a 30s TTL cache (same pattern as
// ChainRegistryService); every admin write invalidates the cache (AC-9: new
// values apply to fresh quotes within 60s, no deploy) and emits a security
// event (who/when/old-new, spec §4.3).
//
// Unavailable DB / unmigrated table / zero rows → the frozen in-code
// FEE_POLICY_TABLE (common/solana-relay.ts) so fresh local dev and old
// unit-test doubles keep working. Monad (10143) and Arbitrum Sepolia
// (421614) map to 0 here even though the frozen table's EVM fallback would
// give them the Ethereum floor (spec §4.4, AC-14 — the override lives in this
// service so the frozen table + its pins stay untouched).
import { BadRequestException, Injectable } from "@nestjs/common";
import { EVM_CHAINS } from "@peridotvault/pid-core/dist/evm";
import { Prisma } from "@prisma/client";
import { settlementFloorFor } from "../common/chain-fee-floors";
import { SOLANA_DEVNET_REFERENCE, SOLANA_TESTNET_REFERENCE } from "../common/chains";
import {
  FEE_POLICY_TABLE,
  MAX_PROTOCOL_FEE_BPS,
  chainMinBaseUnits,
  feeChainForEvmReference,
  feePolicyVersion as configuredPolicyVersion,
} from "../common/solana-relay";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";

const CACHE_TTL_MS = 30_000;

/** Chain key in policy maps: the registry natural key (`namespace:reference`). */
export function chainKey(namespace: string, reference: string): string {
  return `${namespace}:${reference}`;
}

export interface FeePolicySnapshot {
  version: number;
  bps: number;
  active: boolean;
  fxSource: string;
  fxAsOf: Date | null;
  updatedAt: Date;
  minima: Map<string, bigint>;
}

export interface FeePolicyPublicView {
  version: number;
  bps: number;
  minFee: Record<string, string>;
  fxSource: string;
  fxAsOf: string | null;
  updatedAt: string;
}

export type SubmitVersionCheck =
  | { ok: true; warning?: string }
  | { ok: false; code: "UnknownFeePolicy" | "StaleQuote"; status: 400 | 410; message: string };

export interface SubsidyRecord {
  pid: string;
  namespace: string;
  reference: string;
  kind: string;
  quotedFee: bigint;
  actualCost: bigint;
  txHash?: string;
}

@Injectable()
export class FeePolicyService {
  private cache: { at: number; policies: Map<number, FeePolicySnapshot>; activeVersion: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly security: SecurityEventService,
  ) {}

  /** Drop the cache — called by every admin write. */
  invalidate(): void {
    this.cache = null;
  }

  /** All policy versions (cached 30s). Never throws — falls back to the frozen table. */
  async policies(): Promise<{ policies: Map<number, FeePolicySnapshot>; activeVersion: number }> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache;
    const loaded = await this.readPolicies().catch(() => this.codeFallback());
    this.cache = { at: now, ...loaded };
    return loaded;
  }

  /** The active (quoting) policy version. */
  async activePolicy(): Promise<FeePolicySnapshot> {
    const { policies, activeVersion } = await this.policies();
    const row = policies.get(activeVersion);
    if (!row) throw new BadRequestException("No fee policy available");
    return row;
  }

  /** Policy row for an exact version (submit paths settle under the signed version). */
  async policyByVersion(version: number): Promise<FeePolicySnapshot | undefined> {
    return (await this.policies()).policies.get(version);
  }

  /**
   * MIN_FEE + percentage leg for one chain under an exact version. Submit
   * paths settle under the SIGNED version (v1 traffic keeps v1 math); a
   * chain with no row reads 0 (DB is authoritative — add the row via the
   * admin API when onboarding a chain). Throws `UnknownFeePolicy` for
   * versions the backend does not know.
   */
  async minFeeForVersion(
    namespace: string,
    reference: string,
    version: number,
  ): Promise<{ minFee: bigint; bps: number }> {
    const row = await this.policyByVersion(version);
    if (!row) {
      throw new BadRequestException({ code: "UnknownFeePolicy", message: "Unsupported fee policy — re-quote and try again" });
    }
    return { minFee: row.minima.get(chainKey(namespace, reference)) ?? 0n, bps: row.bps };
  }

  /** MIN_FEE for one chain under the active policy (0 when the chain has no row). */
  async minFeeFor(namespace: string, reference: string): Promise<{ minFee: bigint; version: number; bps: number }> {
    const policy = await this.activePolicy();
    return { minFee: policy.minima.get(chainKey(namespace, reference)) ?? 0n, version: policy.version, bps: policy.bps };
  }

  /**
   * Submit-time version gate (spec §4.3, NFR-6/AC-11): the active version and
   * one version back are accepted (the older with a warning — v1 traffic keeps
   * v1 math); anything older is `StaleQuote` (410), anything unknown (or from
   * the future) is `UnknownFeePolicy` (400).
   */
  async checkSubmitVersion(submitted: number): Promise<SubmitVersionCheck> {
    const { policies, activeVersion } = await this.policies();
    if (!policies.has(submitted)) {
      return { ok: false, code: "UnknownFeePolicy", status: 400, message: "Unsupported fee policy — re-quote and try again" };
    }
    if (submitted === activeVersion) return { ok: true };
    if (submitted > activeVersion) {
      return { ok: false, code: "UnknownFeePolicy", status: 400, message: "Unsupported fee policy — re-quote and try again" };
    }
    if (activeVersion - submitted <= 1) {
      return {
        ok: true,
        warning: `Quote uses fee-policy v${submitted}; current is v${activeVersion} — amounts re-attested under v${submitted}`,
      };
    }
    return { ok: false, code: "StaleQuote", status: 410, message: "Fee policy superseded — re-quote and try again" };
  }

  /** Public read-only view for `GET /v1/fee-policy` (AC-18). */
  async publicView(): Promise<FeePolicyPublicView> {
    const policy = await this.activePolicy();
    const minFee: Record<string, string> = {};
    for (const [key, value] of [...policy.minima.entries()].sort()) minFee[key] = value.toString();
    return {
      version: policy.version,
      bps: policy.bps,
      minFee,
      fxSource: policy.fxSource,
      fxAsOf: policy.fxAsOf ? policy.fxAsOf.toISOString() : null,
      updatedAt: policy.updatedAt.toISOString(),
    };
  }

  /** Admin list (newest first) with minima as decimal strings. */
  async listPolicies() {
    const { policies, activeVersion } = await this.policies();
    return [...policies.values()]
      .sort((a, b) => b.version - a.version)
      .map((p) => ({
        version: p.version,
        bps: p.bps,
        active: p.version === activeVersion,
        fxSource: p.fxSource,
        fxAsOf: p.fxAsOf ? p.fxAsOf.toISOString() : null,
        updatedAt: p.updatedAt.toISOString(),
        minima: Object.fromEntries([...p.minima.entries()].map(([k, v]): [string, string] => [k, v.toString()])),
      }));
  }

  /**
   * Admin: publish a new policy version (inactive by default). New versions
   * only — published rows are never mutated (spec §4.3). Every minimum must
   * sit at or above the chain's settlement floor or the write is rejected
   * with `ChainMinBelowFloor` (AC-10).
   */
  async createPolicy(
    pid: string,
    input: { bps: number; minima: Array<{ namespace: string; reference: string; minFee: string }>; fxSource?: string; fxAsOf?: string },
  ): Promise<{ version: number; bps: number; active: boolean }> {
    const { bps, minima } = input;
    if (!Number.isInteger(bps) || bps < 0 || bps > MAX_PROTOCOL_FEE_BPS) {
      throw new BadRequestException({ code: "FeeBpsOutOfRange", message: `bps must be an integer 0..${MAX_PROTOCOL_FEE_BPS}` });
    }
    const parsed = minima.map((m) => this.validateMinimum(m.namespace, m.reference, m.minFee));
    let fxAsOf: Date | null = null;
    if (input.fxAsOf !== undefined) {
      fxAsOf = new Date(input.fxAsOf);
      if (Number.isNaN(fxAsOf.getTime())) throw new BadRequestException("fxAsOf must be an ISO-8601 date");
    }
    const existing = await this.prisma.chainFeePolicy.findMany({ select: { version: true } }).catch(() => []);
    const version = existing.reduce((max, r) => Math.max(max, r.version), 0) + 1;
    await this.prisma.chainFeePolicy.create({
      data: {
        version,
        bps,
        active: false,
        fxSource: input.fxSource?.trim() || "FALLBACK_STATIC",
        fxAsOf,
        minima: { create: parsed.map((m) => ({ namespace: m.namespace, reference: m.reference, minFee: m.minFee })) },
      },
    });
    this.invalidate();
    await this.security.log(pid, "admin.fee_policy.created", { version, bps, chainCount: parsed.length });
    return { version, bps, active: false };
  }

  /** Admin: activate one version (deactivates the rest). Changes apply to fresh quotes within the 30s cache TTL (AC-9). */
  async activatePolicy(pid: string, version: number): Promise<{ version: number; previousVersion: number }> {
    const row = await this.prisma.chainFeePolicy.findUnique({ where: { version } });
    if (!row) throw new BadRequestException({ code: "UnknownFeePolicy", message: `Fee policy v${version} does not exist` });
    const previous = await this.prisma.chainFeePolicy.findFirst({ where: { active: true }, select: { version: true } });
    await this.prisma.$transaction([
      this.prisma.chainFeePolicy.updateMany({ where: { active: true }, data: { active: false } }),
      this.prisma.chainFeePolicy.update({ where: { version }, data: { active: true } }),
    ]);
    this.invalidate();
    await this.security.log(pid, "admin.fee_policy.activated", {
      version,
      previousVersion: previous?.version ?? null,
    });
    return { version, previousVersion: previous?.version ?? version };
  }

  /**
   * Record one quote–actual pair in the subsidy ledger (spec §5.4/NFR-4).
   * Callers treat this as best-effort (`.catch(warn)`, same as reconcile
   * logging) — a ledger write failure must never fail the user flow.
   */
  async recordSubsidy(entry: SubsidyRecord): Promise<void> {
    await this.prisma.relayerSubsidyLedger.create({
      data: {
        pid: entry.pid,
        namespace: entry.namespace,
        reference: entry.reference,
        kind: entry.kind,
        quotedFee: entry.quotedFee,
        actualCost: entry.actualCost,
        subsidy: entry.actualCost - entry.quotedFee,
        txHash: entry.txHash ?? null,
      },
    });
  }

  /** Daily quote-vs-actual aggregates for the internal dashboard (NFR-4). */
  async subsidyDailySummary(days: number): Promise<
    Array<{ day: string; count: number; quotedTotal: string; actualTotal: string; subsidyTotal: string }>
  > {
    const clamped = Number.isInteger(days) && days >= 1 && days <= 90 ? days : 30;
    const rows = await this.prisma.$queryRaw<
      Array<{ day: Date; count: bigint; quotedTotal: string; actualTotal: string; subsidyTotal: string }>
    >(Prisma.sql`
      SELECT DATE("createdAt") AS day, COUNT(*) AS count,
        COALESCE(SUM("quotedFee"), 0)::text AS "quotedTotal",
        COALESCE(SUM("actualCost"), 0)::text AS "actualTotal",
        COALESCE(SUM("subsidy"), 0)::text AS "subsidyTotal"
      FROM "relayer_subsidy_ledger"
      WHERE "createdAt" >= NOW() - (${clamped} || ' days')::interval
      GROUP BY DATE("createdAt") ORDER BY day DESC`);
    return rows.map((r) => ({
      day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
      count: Number(r.count),
      quotedTotal: r.quotedTotal,
      actualTotal: r.actualTotal,
      subsidyTotal: r.subsidyTotal,
    }));
  }

  private validateMinimum(
    namespace: string,
    reference: string,
    minFee: string,
  ): { namespace: string; reference: string; minFee: bigint } {
    if (namespace !== "solana" && namespace !== "eip155") {
      throw new BadRequestException({ code: "UnknownChain", message: `Unknown chain namespace "${namespace}"` });
    }
    const ref = reference?.trim() ?? "";
    if (!ref || ref.length > 128) {
      throw new BadRequestException({ code: "UnknownChain", message: "Chain reference must be 1..128 chars" });
    }
    if (!/^\d+$/.test(minFee)) {
      throw new BadRequestException({ code: "InvalidMinFee", message: "minFee must be a non-negative integer (base units)" });
    }
    const value = BigInt(minFee);
    const floor = settlementFloorFor(namespace, ref);
    if (value < floor) {
      throw new BadRequestException({
        code: "ChainMinBelowFloor",
        message: `minFee ${value} is below the on-chain settlement floor ${floor} for ${namespace}:${ref} — lowering the floor needs a contract upgrade, not a dashboard edit`,
      });
    }
    return { namespace, reference: ref, minFee: value };
  }

  private async readPolicies(): Promise<{ policies: Map<number, FeePolicySnapshot>; activeVersion: number }> {
    const rows = await this.prisma.chainFeePolicy.findMany({
      include: { minima: true },
      orderBy: { version: "asc" },
    });
    if (rows.length === 0) return this.codeFallback();
    const policies = new Map<number, FeePolicySnapshot>();
    for (const r of rows) {
      const minima = new Map<string, bigint>();
      for (const m of r.minima) minima.set(chainKey(m.namespace, m.reference), m.minFee);
      policies.set(r.version, {
        version: r.version,
        bps: r.bps,
        active: r.active,
        fxSource: r.fxSource,
        fxAsOf: r.fxAsOf,
        updatedAt: r.updatedAt,
        minima,
      });
    }
    const active = rows.find((r) => r.active) ?? rows[rows.length - 1];
    return { policies, activeVersion: active.version };
  }

  /**
   * Frozen-table fallback (no DB rows yet): the active in-code row mapped onto
   * registry natural keys. Monad/Arb are pinned to 0 here (spec §4.4) even
   * though `feeChainForEvmReference` would hand them the Ethereum floor.
   */
  private codeFallback(): { policies: Map<number, FeePolicySnapshot>; activeVersion: number } {
    const table = FEE_POLICY_TABLE[configuredPolicyVersion()] ? configuredPolicyVersion() : 1;
    const version = table;
    const row = FEE_POLICY_TABLE[version];
    const minima = new Map<string, bigint>();
    for (const c of EVM_CHAINS) {
      const min =
        c.chainReference === "10143" || c.chainReference === "421614"
          ? 0n
          : chainMinBaseUnits(feeChainForEvmReference(c.chainReference), version);
      minima.set(chainKey("eip155", c.chainReference), min);
    }
    for (const ref of [SOLANA_DEVNET_REFERENCE, SOLANA_TESTNET_REFERENCE]) {
      minima.set(chainKey("solana", ref), chainMinBaseUnits("solana", version));
    }
    const now = new Date();
    const policies = new Map<number, FeePolicySnapshot>();
    for (const [v, r] of Object.entries(FEE_POLICY_TABLE)) {
      policies.set(Number(v), {
        version: Number(v),
        bps: r.bps,
        active: Number(v) === version,
        fxSource: "FALLBACK_STATIC",
        fxAsOf: null,
        updatedAt: now,
        minima: Number(v) === version ? minima : new Map(),
      });
    }
    return { policies, activeVersion: version };
  }
}
