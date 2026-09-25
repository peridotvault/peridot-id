import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import {
  buildInvoiceNumber,
  calcServiceFee,
  DEFAULT_FEE_POLICY,
  mapSacStatus,
  parseCheckoutNotify,
  parseIdrStrict,
  ProviderError,
  type DokuCheckoutClient,
  type SubAccountProvider,
} from "@peridotvault/pid-payments";
import { replayJournal } from "./ledger-replay";
import { FiatLedgerService } from "./fiat-ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import { CHECKOUT_CLIENT } from "./checkout-client.token";
import { SUBACCOUNT_PROVIDER } from "./subaccount-provider.token";

const PROVIDER = "doku-sub-account";
const IDR_ACCOUNT = "DOKU_MERCHANT_IDR";
const PENDING_ACCOUNT = "DOKU_MERCHANT_PENDING_IDR";
/** Unified Ledger spendable account (non-cash, 1:1 IDR peg). */
const POINT_ACCOUNT = "DOKU_MERCHANT_POINT";
/** Checkout order.amount is an integer ≤12 digits (documented). */
const MAX_CHECKOUT_GROSS = 999_999_999_999n;
/** Minimum Checkout top-up, NET IDR, enforced by the Peridot API only.
 *  No minimum-deposit rule is configured at DOKU. */
export const MIN_CHECKOUT_NET_IDR = 100_000n;

/** Gateway payloads are JSON by contract — cast once, at the boundary. */
const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

export interface SubAccountView {
  status: string;
  currency: "IDR";
  profileId: string | null;
  accountNo: string | null;
  pointAccountNo: string | null;
  vaNumber: string | null;
  phoneNo: string | null;
  email: string | null;
  lastBalanceIdr: string | null;
  lastBalanceAt: Date | null;
}

export interface SubTxView {
  id: string;
  kind: string;
  providerRef: string;
  providerStatus: string;
  /** Gross movement, whole IDR (deposit: customer-paid; transfer: requested). */
  grossIdr: string;
  /** Platform fee, whole IDR (snapshotted from the intent quote; legacy fee
   *  rows may also exist for history). */
  feeIdr: string | null;
  /** Net user effect, whole IDR (gross − fee once known). */
  netIdr: string | null;
  /** DOKU-hosted payment page for unpaid Checkout deposits (null otherwise). */
  paymentUrl: string | null;
  /** Fee-leg status (`{ref}-FEE` row): settled | processing | failed | null. */
  feeStatus: string | null;
  currency: "IDR";
  createdAt: Date;
}

interface FeeParams {
  version: number;
  percentBps: number;
  minIdr: bigint;
  maxIdr: bigint;
}

/**
 * Peridot as identity/orchestration, DOKU Sub-Account V2 as the authoritative
 * fiat ledger (1 PID → 1 User Sub-Account under the `Users` parent; `Treasury`
 * is a separate system sub-account under the merchant root — never product
 * parents). Local rows hold the PID↔profileId mapping, provider status,
 * cached reads, transaction references (gross/fee/net), webhook/idempotency
 * records and fee snapshots only — never a balance.
 *
 * Deposit money model (Checkout, NET-in): the user enters the NET amount they
 * want credited (minimum Rp100.000, enforced here — no DOKU-side minimum).
 * fee = flat 5% of net (round-half-up, no floor, no cap), gross = net + fee.
 * The customer is charged gross at DOKU Checkout; fiat settles 100% to the
 * user's IDR account as POINTS backing (no fiat split — the fee moves as
 * Treasury points at issuance, never as a post-settlement fiat debit).
 * NOTE: DOKU deducts its own PG/channel fee BEFORE applying our split, so
 * the user receives 95% × (gross − PGfee) — approximately, not exactly, the
 * quoted net. The API never debits a fee after settlement (no settleFee,
 * no auto-split, no user-facing fee endpoint).
 * Internal transfers stay GROSS-in: the requested amount is gross, the
 * recipient receives net (gross − quoted fee); no separate fee movement.
 * (Bank/e-wallet payouts are deferred.)
 *
  * Payment vs settlement vocabulary (no overload — see correction log):
  * `providerPaymentStatus` on a deposit means PAYMENT state only:
  * pending | success (Checkout transaction SUCCESS, corroborated +
  * amount-matched; VA only behind PID_VA_ISSUANCE_ENABLED) | expired |
  * failed | refunded. `providerStatus` is dual-written for history compat
  * (success/settled/failed/...) but is NEVER the issuance gate — the gate
  * reads `isPaymentConfirmedRow`, which prefers providerPaymentStatus and
  * falls back to legacy providerStatus for pre-split rows.
  * `settlementStatus` (pending | settled | failed) tracks fiat
  * settlement/backing ONLY and never gates issuance. Sub-Account
  * `transactions-status` codes are movement state for legs and the
  * provisional VA-rail signal — never the payment signal for Checkout rows.
 */
@Injectable()
export class FiatSubAccountService {
  private readonly logger = new Logger(FiatSubAccountService.name);
  /** Pids with a register call currently in flight (single-instance guard —
   *  a second concurrent call gets 409 instead of forking a second account).
   *  NOTE: not shared across horizontally-scaled instances. */
  private readonly registering = new Set<string>();
  /** Per-PID serialization chains for money movements (single-instance, same
   *  posture as `registering`). Same-PID confirms/issues/clawbacks run
   *  sequentially; cross-PID transfers lock sender+recipient in sorted order
   *  (deadlock-free). DOKU remains the final arbiter — the mutex only stops
   *  our side from interleaving check-then-act sequences. */
  private readonly pidLocks = new Map<string, Promise<void>>();

  private async withPidLocks<T>(pids: string[], fn: () => Promise<T>): Promise<T> {
    const keys = [...new Set(pids)].sort();
    const prev = keys.map((k) => this.pidLocks.get(k) ?? Promise.resolve());
    let release!: () => void;
    const cur = new Promise<void>((res) => { release = res; });
    keys.forEach((k) => this.pidLocks.set(k, cur));
    await Promise.all(prev);
    try {
      return await fn();
    } finally {
      release();
      keys.forEach((k) => { if (this.pidLocks.get(k) === cur) this.pidLocks.delete(k); });
    }
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(SUBACCOUNT_PROVIDER) private readonly sac: SubAccountProvider,
    @Inject(CHECKOUT_CLIENT) private readonly checkout: DokuCheckoutClient,
    private readonly security: SecurityEventService,
    private readonly ledger: FiatLedgerService,
  ) {}

  /**
   * Payment-confirmation predicate for deposit rows. New writes use
   * "success"; pre-change rows carry legacy "settled" meaning paid.
   * Settlement state is NEVER consulted here — see settlementStatus.
   */
  private isPaymentConfirmedStatus(status: string | null | undefined): boolean {
    return status === "success" || status === "settled";
  }

  /**
   * Issuance gate: prefers providerPaymentStatus (post-split writes);
   * falls back to legacy providerStatus for pre-split rows. Settlement
   * state is never consulted — settlement is backing, not payment.
   */
  private isPaymentConfirmedRow(row: { providerPaymentStatus?: string | null; providerStatus: string }): boolean {
    const payment = row.providerPaymentStatus ?? null;
    if (payment != null) return payment === "success";
    return this.isPaymentConfirmedStatus(row.providerStatus);
  }

  /**
   * Write payment truth + legacy providerStatus together (dual-write keeps
   * history queries and the API shape working while the gate reads the
   * payment column). Checkout SUCCESS and corroborated VA success are the
   * only writers of "success" for deposits; settlement rows never call this.
   */
  private markPayment(id: string, payment: "success" | "expired" | "failed" | "refunded" | "pending", raw: unknown) {
    const legacy =
      payment === "success" ? "success"
      : payment === "expired" ? "cancelled"
      : payment === "failed" ? "failed"
      : payment === "refunded" ? "refunded"
      : "processing";
    return this.prisma.fiatProviderTransaction.update({
      where: { id },
      data: { providerStatus: legacy, providerPaymentStatus: payment, providerResponse: json(raw ?? {}) },
    });
  }

  /**
   * Map a Sub-Account movement status to deposit payment vocabulary.
   * Used for the VA rail + transfer legs only — never for Checkout rows
   * (their payment truth is the Checkout order status).
   */
  private mapSacToPayment(status: string): "success" | "failed" | "refunded" | "pending" {
    if (status === "settled") return "success";
    if (status === "failed") return "failed";
    if (status === "refunded") return "refunded";
    if (status === "cancelled") return "failed"; // void-topup code; terminal, never confirmed
    return "pending";
  }

  /**
   * Hard prerequisite for ALL POINT issuance (correction §6): the Unified
   * Ledger (DOKU_NON_FIAT TOPUP + SYSTEM_POINT funding) must be
   * live-verified and explicitly activated. Until then issuance fails safe —
   * rows stay pending, zero journal writes, zero fabricated balance.
   */
  private unifiedLedgerActive(): boolean {
    return this.config.get<string>("PID_UNIFIED_LEDGER_ACTIVE", "false") === "true";
  }

  /**
   * VA-rail issuance kill-switch (PROVIDER-DEP-01): whether txStatus "00"
   * (+ SUCCESS notify) actually means payment-received for VA credits is
   * UNVERIFIED — flip only after live sandbox evidence names the true
   * payment-confirmation signal. Until then VA rows stay pending.
   */
  private vaIssuanceEnabled(): boolean {
    return this.config.get<string>("PID_VA_ISSUANCE_ENABLED", "false") === "true";
  }

  /** Best-effort whole-IDR parse of a txStatus amount value (null when absent/unparseable). */
  private corroboratedAmount(value: unknown): bigint | null {
    if (value == null) return null;
    try {
      return parseIdrStrict(value as string, "corroborated amount");
    } catch {
      return null;
    }
  }

  /** True when the row was created by our Checkout flow (invoice owns the ref). */
  private isCheckoutRow(cp: Record<string, any> | null | undefined): boolean {
    return (cp as Record<string, any> | null)?.channel === "checkout";
  }

  // --- account lifecycle (server-side register: name + email only) ---

  /**
   * Register (or resume) the caller's Sub-Account. Idempotent per pid AND
   * race-safe: the `creating` row is inserted BEFORE the DOKU call, and an
   * in-memory in-flight set rejects truly concurrent duplicates with 409.
   * A failed call marks the row `failed` (never stuck `creating`), so retry
   * works immediately. Re-registering over a dead `creating`/`failed` row is
   * safe when nothing is in flight — with a warn log, since the original
   * DOKU call may have succeeded server-side (possible orphan).
   *
   * V2 requires only name + email (no phone, no OTP).
   */
  async registerAccount(pid: string, input: { name: string; email: string }): Promise<SubAccountView> {
    // Synchronous add BEFORE any await — airtight same-process guard: two
    // interleaved calls cannot both pass, since neither has yielded yet.
    if (this.registering.has(pid)) {
      throw new ConflictException("Registration already in progress — try again shortly");
    }
    this.registering.add(pid);
    try {
      return await this.registerAccountInner(pid, input);
    } finally {
      this.registering.delete(pid);
    }
  }

  private async registerAccountInner(pid: string, input: { name: string; email: string }): Promise<SubAccountView> {
    const existing = await this.prisma.fiatProviderAccount.findUnique({ where: { pid_provider: { pid, provider: PROVIDER } } });
    if (existing?.profileId) return this.toAccountView(existing);
    if (existing && !existing.profileId) {
      this.logger.warn(`re-registering ${pid} over status=${existing.accountStatus} (possible orphan at DOKU if the original call landed)`);
    }
    const registerRef = buildInvoiceNumber("SA");
    const rowId = existing?.id;
    let row = existing;
    if (!rowId || !row) {
      try {
        row = await this.prisma.fiatProviderAccount.create({
          data: { pid, provider: PROVIDER, email: input.email, accountStatus: "creating", registerRef },
        });
      } catch {
        const reread = await this.prisma.fiatProviderAccount.findUnique({ where: { pid_provider: { pid, provider: PROVIDER } } });
        if (reread?.profileId) return this.toAccountView(reread);
        throw new ConflictException("Registration already in progress — try again shortly");
      }
    } else {
      row = await this.prisma.fiatProviderAccount.update({
        where: { id: rowId },
        data: { registerRef, email: input.email, accountStatus: "creating" },
      });
    }
    // NOTE: no auto-retry here — a network error after DOKU success would
    // create a second sub-account. Failures mark the row `failed` instead.
    let result;
    try {
      result = await this.sac.register({
        partnerReferenceNo: registerRef,
        type: this.config.get<string>("DOKU_SAC_TYPE", "DEFAULT") || "DEFAULT",
        name: input.name,
        email: input.email,
        countryCode: this.config.get<string>("DOKU_SAC_COUNTRY", "ID") || "ID",
        // Hierarchy: Peridot ID (merchant root) → Users (parent for every
        // PID financial account) → this PID's sub-account. Exactly
        // 1 PID = 1 User Sub-Account. Never product parents (no Live2Dev /
        // Peridot split — one balance per PID). Users + Treasury are
        // provisioned once via the DOKU dashboard; their IDs live in env.
        // DOKU_SAC_PARENT_PROFILE_ID is kept as a legacy fallback only.
        parentProfileId:
          this.config.get<string>("DOKU_USERS_PARENT_PROFILE_ID", "") ||
          this.config.get<string>("DOKU_SAC_PARENT_PROFILE_ID", "") ||
          undefined,
      });
    } catch (err) {
      const raw = String(err instanceof Error ? err.message : err).slice(0, 300);
      await this.prisma.fiatProviderAccount
        .update({
          where: { id: row.id },
          data: {
            accountStatus: "failed",
            providerResponse: json({ registerRef, error: raw }),
          },
        })
        .catch(() => undefined);
      // The email already owns a DOKU sub-account (typically: an earlier call
      // landed server-side but the response never reached us). Retrying with
      // the same email can never succeed — ops must link the existing
      // profileId (DOKU dashboard → UPDATE fiat_provider_accounts SET
      // profileId, accountStatus='active' WHERE pid=…), after which balance()
      // fills in the accounts cache.
      if (/already exists/i.test(raw)) {
        this.logger.error(`DOKU register orphan for ${pid}: ${raw}`);
        throw new ConflictException("This email already owns a DOKU sub-account — ops must link the existing profileId before retrying");
      }
      throw this.mapError(err, "sub-account registration");
    }
    const idr = result.accounts.find((a) => a.type === IDR_ACCOUNT)?.accountNo ?? null;
    const point = result.accounts.find((a) => a.type === POINT_ACCOUNT)?.accountNo ?? null;
    const updated = await this.prisma.fiatProviderAccount.update({
      where: { id: row.id },
      data: {
        profileId: result.profileId, providerAccountId: idr, pointAccountId: point, accounts: json(result.accounts),
        vaNumber: result.vaNumber ?? null, email: input.email,
        accountStatus: "active", registerRef, providerResponse: json(result.rawResponse),
      },
    });
    await this.security.log(pid, "fiat.subaccount.registered", { profileId: result.profileId }).catch(() => undefined);
    return this.toAccountView(updated);
  }

  async status(pid: string): Promise<SubAccountView> {
    const account = await this.prisma.fiatProviderAccount.findUnique({ where: { pid_provider: { pid, provider: PROVIDER } } });
    if (!account) throw new NotFoundException("Sub-account not registered");
    return this.toAccountView(account);
  }

  /** Static BRI VA + IDR account for deposits. */
  async depositVa(pid: string): Promise<{ vaNumber: string | null; accountNo: string | null; profileId: string }> {
    const account = await this.requireActive(pid);
    if (!account.profileId) throw new ServiceUnavailableException("Sub-account not registered");
    return { vaNumber: account.vaNumber, accountNo: account.providerAccountId, profileId: account.profileId };
  }

  /** Bank-agnostic money-in channels (verified compatibility table). */
  depositChannels() {
    return [
      { id: "checkout", label: "DOKU Checkout — all banks, QRIS, e-money, cards", via: "checkout" },
      { id: "bri_va", label: "BRI Virtual Account (static, real-time)", via: "bri_va" },
    ] as const;
  }

  // --- Checkout money-in (bank-agnostic, DOKU-hosted page) ---

  /**
   * Create a Checkout deposit intent (NET-in): the entered amount is the NET
   * the user wants credited (minimum Rp100.000 — API-enforced, no DOKU
   * minimum). fee = flat 5% of net, gross = net + fee. Local row first
   * (gross stored, fee/net quote snapshotted), then the DOKU-hosted payment
   * page routed to this PID's sub-account. The customer is charged gross;
   * fiat settles 100% to the user IDR account as POINTS backing (no fiat
   * split — the fee moves as Treasury points at issuance, never as a
   * post-settlement fiat debit). No API-side fiat fee debit happens.
   */
  async createCheckoutDeposit(pid: string, netAmountIdr: string, appClientId?: string | null) {
    const net = this.parseGross(netAmountIdr);
    if (net < MIN_CHECKOUT_NET_IDR) throw new BadRequestException("Minimum top-up is Rp100.000");
    // No DOKU Sub-Account required: Checkout money-in lands on the merchant
    // account; every user balance lives on the internal fiat ledger.
    // Fee = global PeridotID + (when an app initiated this) that app's fee.
    const { globalFee, appFee, appId, appOwnerPid, policyVersion } = await this.ledger.quoteFees(appClientId, "topup", net);
    const fee = globalFee + appFee;
    const gross = net + fee;
    if (gross > MAX_CHECKOUT_GROSS) throw new BadRequestException("Amount exceeds Checkout 12-digit limit");
    const providerRef = buildInvoiceNumber("DP");
    // Optional: route to a legacy sub-account if one happens to exist.
    const account = await this.prisma.fiatProviderAccount
      .findUnique({ where: { pid_provider: { pid, provider: PROVIDER } } })
      .catch(() => null);
    const row = await this.prisma.fiatProviderTransaction.create({
      data: {
        pid, accountId: account?.providerAccountId ?? null, kind: "deposit", providerRef,
        providerStatus: "created", amountIdr: gross,
        feeIdr: globalFee, netIdr: net, feePolicyVersion: policyVersion,
        ledgerStatus: "pending", settlementStatus: "pending",
        counterparty: {
          channel: "checkout", feeQuote: globalFee.toString(), netQuote: net.toString(),
          feePolicyVersion: policyVersion,
          ...(appId && appOwnerPid ? { appId, appOwnerPid, appFeeQuote: appFee.toString() } : {}),
        },
      },
    });
    let payment;
    try {
      payment = await this.withRetry(
        () => this.checkout.createPayment({
          invoiceNumber: providerRef,
          grossAmountIdr: gross,
          ...(account?.profileId ? { profileId: account.profileId } : {}),
          // Customer name rendered by DOKU is always the pid — never the
          // display name (dashboard/label consistency, no impersonation).
          customer: { id: pid, name: pid, phone: account?.phoneNo ?? undefined, email: account?.email ?? undefined },
          notifyUrl: this.config.get<string>("DOKU_CHECKOUT_NOTIFY_URL", "") || this.config.get<string>("DOKU_WEBHOOK_URL", "") || undefined,
        }),
        "checkout payment",
      );
    } catch (err) {
      await this.markTx(row.id, "failed", err);
      throw this.mapError(err, "checkout payment");
    }
    const updated = await this.markTx(row.id, "created", payment.rawResponse);
    await this.security.log(pid, "fiat.subaccount.checkout", { providerRef }).catch(() => undefined);
    return this.toCheckoutView(updated, payment, fee, policyVersion);
  }

  // --- authoritative reads (DOKU is the ledger) ---

  /**
   * Live balance from DOKU. The spendable Saldo is the Unified Ledger POINT
   * balance (1:1 IDR peg); fiat IDR/pending are backing (admin/debug).
   * Local lastBalance is a timestamped cache only.
   */
  async balance(pid: string): Promise<{
    pointsAvailableIdr: string; pointsReservedIdr: string;
    availableIdr: string; reservedIdr: string; pendingIdr: string;
    currency: "IDR"; cachedAt: Date;
  }> {
    const account = await this.requireActive(pid);
    if (!account.profileId) throw new ServiceUnavailableException("Sub-account not registered");
    let result;
    try {
      result = await this.withRetry(() => this.sac.balance(account.profileId as string), "balance");
    } catch (err) {
      throw this.mapError(err, "balance");
    }
    const idr = result.accounts.find((a) => a.type === IDR_ACCOUNT);
    const pending = result.accounts.find((a) => a.type === PENDING_ACCOUNT);
    const point = result.accounts.find((a) => a.type === POINT_ACCOUNT);
    let available: bigint;
    let reserved: bigint;
    let pendingBal: bigint;
    let pointAvail: bigint;
    let pointReserved: bigint;
    try {
      available = parseIdrStrict(idr?.available ?? "0", "balance.available");
      reserved = parseIdrStrict(idr?.reserved ?? "0", "balance.reserved");
      pendingBal = parseIdrStrict(pending?.available ?? "0", "balance.pending");
      pointAvail = parseIdrStrict(point?.available ?? "0", "balance.points");
      pointReserved = parseIdrStrict(point?.reserved ?? "0", "balance.pointsReserved");
    } catch (err) {
      throw this.mapError(err, "balance");
    }
    const at = new Date();
    const pointAccountId = point?.accountNo ?? account.pointAccountId ?? null;
    await this.prisma.fiatProviderAccount
      .update({
        where: { pid_provider: { pid, provider: PROVIDER } },
        data: {
          lastBalance: available.toString(), lastBalanceAt: at,
          accounts: json(result.accounts),
          ...(pointAccountId && !account.pointAccountId ? { pointAccountId } : {}),
        },
      })
      .catch(() => undefined);
    return {
      pointsAvailableIdr: pointAvail.toString(), pointsReservedIdr: pointReserved.toString(),
      availableIdr: available.toString(), reservedIdr: reserved.toString(), pendingIdr: pendingBal.toString(),
      currency: "IDR", cachedAt: at,
    };
  }

  /** Authoritative history from DOKU (mutation is relative to the queried account). */
  async history(pid: string, q: { accountNo?: string; fromDateTime: string; toDateTime: string; pageSize?: string; pageNumber?: string }) {
    const account = await this.requireActive(pid);
    const accountNo = q.accountNo ?? account.providerAccountId ?? undefined;
    if (!accountNo) throw new ServiceUnavailableException("IDR account unknown");
    try {
      const res = await this.sac.history({
        accountNo,
        fromDateTime: q.fromDateTime,
        toDateTime: q.toDateTime,
        pageSize: q.pageSize ?? "10",
        pageNumber: q.pageNumber ?? "0",
      });
      return { items: res.items };
    } catch (err) {
      throw this.mapError(err, "history");
    }
  }

  // --- money movement (idempotent, providerRef-first) ---

  /**
   * Resolve a PID's spendable POINT account, healing a missing cache via a
   * live balance read. Throws 404 (unknown/no wallet) or 503 (DOKU has no
   * POINT account for them yet).
   */
  private async pointAccountFor(pid: string, what: string): Promise<string> {
    const account = await this.prisma.fiatProviderAccount.findUnique({ where: { pid_provider: { pid, provider: PROVIDER } } });
    if (!account) throw new NotFoundException(`${what} has no IDR wallet yet`);
    if (account.accountStatus !== "active") throw new BadRequestException(`${what} wallet is ${account.accountStatus}`);
    const cached = this.pointAccountOf(account);
    if (cached) return cached;
    // Stale cache (pre-ledger rows) — one live refresh, then read again.
    try {
      await this.balance(pid);
    } catch (err) {
      throw this.mapError(err, `${what} balance`);
    }
    const fresh = await this.prisma.fiatProviderAccount.findUnique({ where: { pid_provider: { pid, provider: PROVIDER } } });
    const healed = fresh ? this.pointAccountOf(fresh) : undefined;
    if (!healed) throw new ServiceUnavailableException(`${what} POINT account unknown — re-register or contact ops`);
    return healed;
  }

  /** POINT accountNo from the row cache (column first, accounts JSON fallback). */
  private pointAccountOf(account: { pointAccountId: string | null; accounts: unknown }): string | undefined {
    if (account.pointAccountId) return account.pointAccountId;
    const list = account.accounts as Array<{ type?: string; accountNo?: string }> | null;
    if (!Array.isArray(list)) return undefined;
    return list.find((a) => a?.type === POINT_ACCOUNT)?.accountNo ?? undefined;
  }

  /** Merchant SYSTEM_POINT account (point issuance source). Env-configured. */
  private systemPointAccount(): string {
    const env = this.config.get<string>("DOKU_SYSTEM_POINT_ACCOUNT_NO", "");
    if (!env) {
      throw new ServiceUnavailableException(
        "DOKU_SYSTEM_POINT_ACCOUNT_NO not configured — Unified Ledger top-ups need the merchant SYSTEM_POINT account (see docs/prds/PRD_v6.md §7)",
      );
    }
    return env;
  }

  /** True when DOKU has actually provided the SYSTEM_POINT funding account.
   *  The activation flag alone cannot move POINT — this is the real DOKU
   *  readiness signal the issuance prerequisite checks before any write. */
  private systemPointConfigured(): boolean {
    return this.config.get<string>("DOKU_SYSTEM_POINT_ACCOUNT_NO", "") !== "";
  }

  /** Treasury POINT account (fee revenue, redeemable). Env preferred, else
   *  resolved once from the Treasury profile and cached 5 minutes. */
  private treasuryPointCache: { value: string; exp: number } | null = null;
  private async treasuryPointAccount(): Promise<string> {
    const env = this.config.get<string>("DOKU_TREASURY_POINT_ACCOUNT_NO", "");
    if (env) return env;
    if (this.treasuryPointCache && Date.now() < this.treasuryPointCache.exp) return this.treasuryPointCache.value;
    const profileId = this.config.get<string>("DOKU_TREASURY_PROFILE_ID", "");
    if (!profileId) {
      throw new ServiceUnavailableException(
        "Treasury POINT account not configured — set DOKU_TREASURY_POINT_ACCOUNT_NO (or DOKU_TREASURY_PROFILE_ID)",
      );
    }
    let bal;
    try {
      bal = await this.withRetry(() => this.sac.balance(profileId), "treasury balance");
    } catch (err) {
      throw this.mapError(err, "treasury balance");
    }
    const point = bal.accounts.find((a) => a.type === POINT_ACCOUNT)?.accountNo;
    if (!point) throw new ServiceUnavailableException("Treasury POINT account not found on its profile");
    this.treasuryPointCache = { value: point, exp: Date.now() + 5 * 60_000 };
    return point;
  }

  /**
   * Internal transfer inquiry (moves no money). POINT P2P on the Unified
   * Ledger: the recipient is addressed by PID (resolved server-side to
   * their POINT account — the sender never handles account numbers).
   * GROSS-in: requested amount is gross points; fee quote + net computed
   * under the active policy and snapshotted. Creates the idempotent row
   * first with the SAME partnerReferenceNo the payment step reuses.
   */
  async transferInquiry(
    pid: string,
    input: { type: "DOKU_SUB_ACCOUNT"; amountIdr: string; beneficiaryPid: string; remark?: string },
  ) {
    const gross = this.parseGross(input.amountIdr);
    const fromAccount = await this.pointAccountFor(pid, "Sender");
    const toAccount = await this.pointAccountFor(input.beneficiaryPid, "Recipient");
    if (input.beneficiaryPid === pid) throw new BadRequestException("Cannot transfer to yourself");
    const kind = "transfer_internal";
    const policy = await this.activeFeePolicy();
    const fee = calcServiceFee(gross, policy);
    const providerRef = buildInvoiceNumber("ST");
    const row = await this.prisma.fiatProviderTransaction.create({
      data: {
        pid, accountId: fromAccount, kind, providerRef, amountIdr: gross,
        feeIdr: fee, netIdr: gross - fee, feePolicyVersion: policy.version,
        counterparty: {
          type: input.type, beneficiaryPid: input.beneficiaryPid, beneficiaryAccountNumber: toAccount,
          feeQuote: fee.toString(), netQuote: (gross - fee).toString(), feePolicyVersion: policy.version,
          currency: "POINT",
        },
      },
    });
    let inquiry;
    try {
      inquiry = await this.sac.transferInquiry({
        partnerReferenceNo: providerRef,
        type: input.type,
        amountIdr: gross,
        currency: "POINT",
        fromAccount,
        beneficiaryAccountNumber: toAccount,
        remark: input.remark,
      });
    } catch (err) {
      await this.markTx(row.id, "failed", err);
      throw this.mapError(err, "transfer inquiry");
    }
    await this.markTx(row.id, "created", inquiry.rawResponse);
    return {
      id: row.id,
      providerRef,
      transferType: input.type,
      accountNumber: toAccount,
      beneficiaryPid: input.beneficiaryPid,
      accountName: inquiry.beneficiaryAccountName ?? null,
      inquiryReferenceNo: inquiry.referenceNo,
      grossIdr: gross.toString(),
      feeIdr: fee.toString(),
      netIdr: (gross - fee).toString(),
      feePolicyVersion: policy.version,
    };
  }

  /**
   * Transfer payment: executes the POINT P2P bound to the inquiry
   * referenceNo — NET points to the recipient — then moves the quoted FEE
   * as a second POINT P2P to Treasury under `{ref}-PTFEE` (journal row
   * `points_fee`). Writes the recipient mirror row (`points_credit`, keyed
   * by DOKU's referenceNo) so the journal reconstructs ownership without
   * trusting any sub-account's location. Serialized per sender+recipient;
   * a failed fee leg never fails the user transfer; the sweep completes it.
   * All snapshotted under the inquiry's policy version.
   */
  async transferConfirm(pid: string, id: string, input: { beneficiaryAccountName: string; expectedName?: string }): Promise<SubTxView> {
    const pre = await this.prisma.fiatProviderTransaction.findFirst({ where: { id, pid } });
    if (!pre) throw new NotFoundException("Transfer not found");
    const preCp = (pre.counterparty ?? {}) as Record<string, any>;
    const lockPids = preCp.beneficiaryPid ? [pid, String(preCp.beneficiaryPid)] : [pid];
    return this.withPidLocks(lockPids, () => this.transferConfirmInner(pid, id, input));
  }

  private async transferConfirmInner(pid: string, id: string, input: { beneficiaryAccountName: string; expectedName?: string }): Promise<SubTxView> {
    const row = await this.prisma.fiatProviderTransaction.findFirst({ where: { id, pid } });
    if (!row) throw new NotFoundException("Transfer not found");
    if (row.kind !== "transfer_internal") throw new BadRequestException("Not a transfer row");
    if (row.providerStatus === "processing" || row.providerStatus === "settled") return this.toTxView(row);
    if (row.providerStatus !== "created") throw new BadRequestException("Transfer is closed — start a new inquiry");
    const fromAccount = await this.pointAccountFor(pid, "Sender");
    const cp = (row.counterparty ?? {}) as Record<string, any>;
    const r = (row.providerResponse ?? {}) as Record<string, any>;
    const inquiryReferenceNo: string | undefined = r?.referenceNo;
    if (!inquiryReferenceNo || !cp.beneficiaryAccountNumber) {
      throw new ServiceUnavailableException("Inquiry handshake incomplete — start a new inquiry");
    }
    if (input.expectedName && r.beneficiaryAccountName && input.expectedName !== String(r.beneficiaryAccountName)) {
      throw new BadRequestException("Holder name changed since inquiry — start a new inquiry");
    }
    const policy = await this.feePolicyByVersion(Number(cp.feePolicyVersion ?? 0));
    const gross = row.amountIdr;
    const fee = calcServiceFee(gross, policy);
    const net = gross - fee;
    const type = "DOKU_SUB_ACCOUNT" as const;
    try {
      const res = await this.withRetry(
        () => this.sac.transferPayment({
          partnerReferenceNo: row.providerRef,
          referenceNo: inquiryReferenceNo,
          type,
          amountIdr: net,
          currency: "POINT",
          fromAccount,
          beneficiaryAccountNumber: String(cp.beneficiaryAccountNumber),
          beneficiaryAccountName: input.beneficiaryAccountName,
        }),
        "transfer payment",
      );
      await this.markTx(row.id, "processing", res.rawResponse);
      await this.prisma.fiatProviderTransaction.update({
        where: { id: row.id },
        data: {
          feeIdr: fee, netIdr: net, feePolicyVersion: policy.version,
          direction: "out", sourceAccount: fromAccount,
          destAccount: String(cp.beneficiaryAccountNumber), entryGroup: row.providerRef,
        },
      }).catch(() => undefined);
      await this.security.log(pid, "fiat.subaccount.transfer", { providerRef: row.providerRef, gross: gross.toString(), fee: fee.toString() }).catch(() => undefined);
      // Corroborate the P2P itself: parent AND mirror settle together, so
      // replay sees the recipient credit exactly when DOKU confirms value.
      // Processing legs stay open for the sweep to corroborate.
      const corroborated = await this.withRetry(() => this.sac.txStatus(row.providerRef), "transfer status").catch(() => null);
      const p2pStatus = corroborated ? mapSacStatus(corroborated.latestTransactionStatus) : "processing";
      if (p2pStatus !== "processing") {
        await this.markTx(row.id, p2pStatus, corroborated?.rawResponse ?? res.rawResponse);
      }
      // Recipient mirror (points_credit, keyed by DOKU's referenceNo): without
      // this row the journal cannot reconstruct who owns the transferred PTS.
      // Written best-effort — the sweep backfills it from corroborated DOKU
      // state, never invented.
      const recipientPid = String(cp.beneficiaryPid ?? "");
      const mirrorRef = res.referenceNo ?? `${row.providerRef}-IN`;
      if (recipientPid) {
        await this.prisma.fiatProviderTransaction.upsert({
          where: { providerRef: mirrorRef },
          create: {
            pid: recipientPid, accountId: String(cp.beneficiaryAccountNumber),
            kind: "points_credit", providerRef: mirrorRef, amountIdr: net,
            feeIdr: null, netIdr: net, providerStatus: p2pStatus,
            direction: "in", sourceAccount: fromAccount,
            destAccount: String(cp.beneficiaryAccountNumber), entryGroup: row.providerRef,
            ledgerRef: mirrorRef, ledgerStatus: p2pStatus === "settled" ? "issued" : "pending",
            counterparty: { parentRef: row.providerRef, linkedRef: row.providerRef, currency: "POINT", source: "transfer" },
            providerResponse: json(res.rawResponse),
          },
          update: p2pStatus === "settled"
            ? { providerStatus: "settled", ledgerStatus: "issued" }
            : {},
        }).catch((err) => {
          this.logger.error(`mirror write failed for ${row.providerRef} — sweep must backfill: ${String(err)?.slice(0, 200)}`);
        });
      }
      // Treasury fee leg (POINT P2P, retryable via sweep under the same ref).
      if (fee > 0n) {
        await this.executePointFeeLeg(pid, fromAccount, `${row.providerRef}-PTFEE`, fee, row.providerRef).catch((err) => {
          this.logger.warn(`transfer treasury leg failed for ${row.providerRef}: ${String(err)?.slice(0, 200)}`);
        });
      }
      if (p2pStatus === "settled") {
        const settled = await this.prisma.fiatProviderTransaction.findFirst({ where: { id, pid } });
        if (settled) return (await this.attachFeeStatus([this.toTxView(settled)]))[0];
      }
      return this.toTxView(await this.markTx(row.id, "processing", res.rawResponse));
    } catch (err) {
      await this.markTx(row.id, "failed", err);
      throw this.mapError(err, "transfer");
    }
  }

  /**
   * Move a quoted fee as POINT P2P to Treasury under one providerRef.
   * Idempotent: an existing settled/processing leg is returned as-is; a
   * failed leg re-executes; 409 → corroborate via transactions-status.
   */
  private async executePointFeeLeg(pid: string, fromPointAccount: string, providerRef: string, fee: bigint, parentRef: string) {
    const existing = await this.prisma.fiatProviderTransaction.findFirst({ where: { kind: "points_fee", providerRef } });
    if (existing && ["settled", "processing"].includes(existing.providerStatus)) return existing;
    const toPointAccount = await this.treasuryPointAccount();
    const legRow = existing ?? (await this.prisma.fiatProviderTransaction.create({
      data: {
        pid, accountId: fromPointAccount, kind: "points_fee", providerRef, amountIdr: fee,
        feeIdr: fee, netIdr: fee, providerStatus: "created",
        direction: "out", sourceAccount: fromPointAccount, destAccount: toPointAccount, entryGroup: parentRef,
        counterparty: { parentRef, currency: "POINT", destination: "treasury" },
      },
    }));
    try {
      const inquiry = await this.withRetry(
        () => this.sac.transferInquiry({
          partnerReferenceNo: providerRef, type: "DOKU_SUB_ACCOUNT", amountIdr: fee, currency: "POINT",
          fromAccount: fromPointAccount, beneficiaryAccountNumber: toPointAccount, remark: `PID treasury fee for ${parentRef}`,
        }),
        "treasury fee inquiry",
      );
      // beneficiaryAccountName is required — use the inquiry answer verbatim.
      const paid = await this.withRetry(
        () => this.sac.transferPayment({
          partnerReferenceNo: providerRef, referenceNo: inquiry.referenceNo, type: "DOKU_SUB_ACCOUNT",
          amountIdr: fee, currency: "POINT", fromAccount: fromPointAccount,
          beneficiaryAccountNumber: toPointAccount,
          beneficiaryAccountName: inquiry.beneficiaryAccountName ?? toPointAccount,
        }),
        "treasury fee payment",
      );
      const st = await this.withRetry(() => this.sac.txStatus(providerRef), "treasury fee status").catch(() => null);
      return await this.markTx(legRow.id, st ? mapSacStatus(st.latestTransactionStatus) : "processing", paid.rawResponse);
    } catch (err) {
      if (err instanceof ProviderError && err.httpStatus === 409) {
        const st = await this.withRetry(() => this.sac.txStatus(providerRef), "treasury fee status");
        return await this.markTx(legRow.id, mapSacStatus(st.latestTransactionStatus), st.rawResponse);
      }
      await this.markTx(legRow.id, "failed", err);
      throw err;
    }
  }

  /**
   * Ensure the recipient mirror row exists for a settled transfer. The mirror
   * is authoritative ONLY when the DOKU movement is corroborated (txStatus
   * settled) — otherwise the ref goes to the manual-review queue and nothing
   * is invented. Returns "mirrored" | "exists" | "review".
   */
  private async ensureTransferMirror(row: {
    id: string; pid: string; providerRef: string; amountIdr: bigint;
    counterparty: unknown; providerResponse: unknown;
  }): Promise<"mirrored" | "exists" | "review"> {
    const cp = (row.counterparty ?? {}) as Record<string, any>;
    const r = (row.providerResponse ?? {}) as Record<string, any>;
    const recipientPid = typeof cp.beneficiaryPid === "string" ? cp.beneficiaryPid : undefined;
    if (!recipientPid || !cp.beneficiaryAccountNumber) return "review";
    const mirrorRef: string | undefined = r?.mirrorRef ?? r?.dokuReferenceNo;
    if (mirrorRef) {
      const hit = await this.prisma.fiatProviderTransaction.findUnique({ where: { providerRef: mirrorRef } }).catch(() => null);
      if (hit) return "exists";
    }
    const linked = await this.prisma.fiatProviderTransaction.findFirst({
      where: { kind: "points_credit", counterparty: { path: ["parentRef"], equals: row.providerRef } },
    }).catch(() => null);
    if (linked) return "exists";
    // Authoritative check: the DOKU P2P itself must be settled.
    let st;
    try {
      st = await this.withRetry(() => this.sac.txStatus(row.providerRef), "mirror corroboration");
    } catch {
      return "review";
    }
    if (mapSacStatus(st.latestTransactionStatus) !== "settled") return "review";
    const dokuRef = (st.rawResponse as Record<string, any> | undefined)?.referenceNo
      ? String((st.rawResponse as Record<string, any>).referenceNo)
      : `${row.providerRef}-IN`;
    const net = BigInt(String(cp.netQuote ?? "0"));
    if (net <= 0n) return "review";
    const fromPoint = await this.pointAccountFor(row.pid, "Sender").catch(() => undefined);
    await this.prisma.fiatProviderTransaction.upsert({
      where: { providerRef: dokuRef },
      create: {
        pid: recipientPid, accountId: String(cp.beneficiaryAccountNumber),
        kind: "points_credit", providerRef: dokuRef, amountIdr: net,
        feeIdr: null, netIdr: net, providerStatus: "settled",
        direction: "in", sourceAccount: fromPoint ?? "unknown", destAccount: String(cp.beneficiaryAccountNumber),
        entryGroup: row.providerRef, ledgerRef: dokuRef, ledgerStatus: "issued",
        counterparty: { parentRef: row.providerRef, linkedRef: row.providerRef, currency: "POINT", source: "mirror-backfill" },
        providerResponse: json(st.rawResponse ?? {}),
      },
      update: {},
    }).catch(() => null);
    await this.prisma.fiatProviderTransaction.update({
      where: { id: row.id },
      data: { providerResponse: json({ ...(r ?? {}), mirrorRef: dokuRef }) },
    }).catch(() => undefined);
    return "mirrored";
  }

  /**
   * Admin: reconstruct historical recipient mirrors from authoritative DOKU
   * state (txStatus per transfer). Anything unresolvable goes to
   * manualReview — never invented.
   */
  async adminBackfillMirrors(input: { take?: number }) {
    const take = Math.min(Math.max(input.take ?? 100, 1), 500);
    const rows = await this.prisma.fiatProviderTransaction.findMany({
      where: { kind: "transfer_internal", providerStatus: { in: ["processing", "settled"] } },
      orderBy: { createdAt: "asc" }, take,
    });
    const mirrored: string[] = [];
    const manualReview: string[] = [];
    for (const row of rows) {
      const linked = await this.prisma.fiatProviderTransaction.findFirst({
        where: { kind: "points_credit", counterparty: { path: ["parentRef"], equals: row.providerRef } },
      }).catch(() => null);
      if (linked) continue;
      const outcome = await this.ensureTransferMirror(row as never).catch(() => "review" as const);
      if (outcome === "mirrored") mirrored.push(row.providerRef);
      else if (outcome === "review") manualReview.push(row.providerRef);
    }
    return { checked: rows.length, mirrored, manualReview };
  }

  /**
   * Safe retry of a failed transfer — reuses the same providerRef. Also
   * covers `created` rows whose inquiry never completed (no referenceNo
   * stored yet); rows already past inquiry keep their handshake.
   * Serialized per sender — a live confirm on the same row wins.
   */
  async retryTransfer(pid: string, id: string): Promise<SubTxView> {
    return this.withPidLocks([pid], () => this.retryTransferInner(pid, id));
  }

  private async retryTransferInner(pid: string, id: string): Promise<SubTxView> {
    const row = await this.prisma.fiatProviderTransaction.findFirst({ where: { id, pid } });
    if (!row) throw new NotFoundException("Transfer not found");
    // Payout kinds are deferred — legacy rows are display-only, never re-executed.
    if (row.kind !== "transfer_internal") return this.toTxView(row);
    if (row.providerStatus !== "failed" && !((row.providerResponse as Record<string, any> | null)?.referenceNo === undefined && row.providerStatus === "created")) {
      return this.toTxView(row);
    }
    const account = await this.requireActive(pid);
    const fromAccount = this.pointAccountOf(account);
    if (!fromAccount) throw new ServiceUnavailableException("POINT account unknown");
    const cp = (row.counterparty ?? {}) as Record<string, any>;
    try {
      const inquiry = await this.sac.transferInquiry({
        partnerReferenceNo: row.providerRef,
        type: "DOKU_SUB_ACCOUNT",
        amountIdr: row.amountIdr,
        currency: "POINT",
        fromAccount,
        beneficiaryAccountNumber: String(cp.beneficiaryAccountNumber),
      });
      return this.toTxView(await this.markTx(row.id, "created", inquiry.rawResponse));
    } catch (err) {
      throw this.mapError(err, "transfer inquiry");
    }
  }

  /** Reconcile any row via the documented Checkout order status (retried). */
  async syncTx(pid: string, id: string): Promise<SubTxView> {
    const row = await this.prisma.fiatProviderTransaction.findFirst({ where: { id, pid } });
    if (!row) throw new NotFoundException("Transaction not found");
    if (!["created", "processing"].includes(row.providerStatus)) {
      return (await this.attachFeeStatus([this.toTxView(row)]))[0];
    }
    const cp = (row.counterparty ?? {}) as Record<string, any>;
    // Checkout rail: payment confirmation comes from the Checkout order
    // status (transaction SUCCESS), never from Sub-Account settlement state.
    if (row.kind === "deposit" && this.isCheckoutRow(cp)) {
      return this.syncCheckoutDeposit(row);
    }
    let res;
    try {
      res = await this.withRetry(() => this.sac.txStatus(row.providerRef), "transaction status");
    } catch (err) {
      // An unpaid Checkout intent has no transaction at DOKU yet — 404 means
      // "not paid", not corruption. Keep the row `created` and say so.
      if (row.kind === "deposit" && row.providerStatus === "created" && err instanceof ProviderError && err.httpStatus === 404) {
        throw new BadRequestException("Not paid yet — open the DOKU payment page to pay, then check again");
      }
      throw this.mapError(err, "transaction status");
    }
    const status = mapSacStatus(res.latestTransactionStatus);
    // Deposits dual-write payment truth (provisional VA semantics — the
    // issuance gate additionally requires the VA kill-switch); transfer
    // legs keep movement state only.
    const updated = row.kind === "deposit"
      ? await this.markPayment(row.id, this.mapSacToPayment(status), res.rawResponse)
      : await this.markTx(row.id, status, res.rawResponse);
    // Paid deposits unlock the Saldo immediately: issue Unified Ledger points
    // (server-corroborated above — never on caller claims). Awaited so the
    // user sees usable balance right after "Check status".
    if (status === "settled" && row.kind === "deposit") {
      await this.issuePointsForDeposit(row.id, "sync");
      // Rail B (temporary internal credit): same corroborated payment, own
      // gate inside (never throws — the POINT path above is unaffected).
      await this.ledger.issueForDeposit(row.id, "sync");
    }
    return (await this.attachFeeStatus([this.toTxView((await this.prisma.fiatProviderTransaction.findFirst({ where: { id, pid } })) ?? updated)]))[0];
  }

  /** Minimal deposit-row shape shared by the Checkout corroboration path. */
  private async syncCheckoutDeposit(row: {
    id: string; pid: string; kind: string; providerRef: string; providerStatus: string;
    amountIdr: bigint; feeIdr: bigint | null; netIdr: bigint | null;
    counterparty: unknown; providerResponse: unknown; createdAt: Date;
  }): Promise<SubTxView> {
    let corr: { outcome: "paid" | "pending" | "expired" | "failed" | "unknown"; paidAmount: bigint | null };
    try {
      corr = await this.withRetry(() => this.corroborateCheckoutPayment(row.providerRef), "checkout order status");
    } catch (err) {
      // Order-level 404 on a fresh intent = unpaid (channel hasn't published
      // anything yet). Keep the row `created` and say so plainly.
      if (err instanceof ProviderError && err.httpStatus === 404 && row.providerStatus === "created") {
        throw new BadRequestException("Not paid yet — open the DOKU payment page to pay, then check again");
      }
      // Endpoint-level failure (e.g. order status not activated for this
      // merchant): fall back to the legacy txStatus path, loudly. Payment
      // semantics stay conservative — issuance still requires its own gate.
      this.logger.warn(`checkout order status unavailable for ${row.providerRef}, falling back to txStatus: ${String(err)?.slice(0, 160)}`);
      await this.prisma.fiatProviderTransaction.update({
        where: { id: row.id },
        data: { counterparty: json({ ...((row.counterparty ?? {}) as Record<string, unknown>), orderStatusUnavailable: true }) },
      }).catch(() => undefined);
      return this.syncLegacyDeposit(row);
    }
    if (corr.outcome === "pending" || corr.outcome === "unknown") {
      return (await this.attachFeeStatus([this.toTxView(row)]))[0];
    }
    if (corr.outcome === "expired") {
      const updated = await this.markPayment(row.id, "expired", { checkoutExpired: true });
      return (await this.attachFeeStatus([this.toTxView(updated)]))[0];
    }
    if (corr.outcome === "failed") {
      const updated = await this.markPayment(row.id, "failed", { checkoutFailed: true });
      return (await this.attachFeeStatus([this.toTxView(updated)]))[0];
    }
    // Paid: amount-match against OUR invoice gross, then mark payment success
    // and issue. Settlement is never consulted here.
    // assertInvoiceAmountMatch blocks (ledgerStatus "blocked") and returns
    // false on mismatch/unverifiable — issuance must not proceed then.
    if (!(await this.assertInvoiceAmountMatch(row.id, row.amountIdr, corr.paidAmount, row.providerRef))) {
      throw new BadRequestException("Paid amount does not match the invoice — held for review");
    }
    const updated = await this.markPayment(row.id, "success", { checkoutPaid: true });
    await this.issuePointsForDeposit(row.id, "sync");
    // Internal fiat ledger (the live Saldo rail): same corroborated payment,
    // own gate inside (never throws — issued only after re-corroboration).
    await this.ledger.issueForDeposit(row.id, "sync");
    return (await this.attachFeeStatus([this.toTxView((await this.prisma.fiatProviderTransaction.findFirst({ where: { id: row.id, pid: row.pid } })) ?? updated)]))[0];
  }

  /**
   * Legacy deposit corroboration via Sub-Account transactions-status.
   * VA rail only (plus pre-change rows): Checkout rows must use
   * corroborateCheckoutPayment instead — txStatus codes track settlement
   * there, never payment. This path writes movement state ONLY (no payment
   * column): for Checkout rows txStatus must never confirm payment, so
   * issuance stays deferred until order-status corroboration lands. An
   * unpaid intent 404s: "not paid", not corruption.
   */
  private async syncLegacyDeposit(row: {
    id: string; pid: string; kind: string; providerRef: string; providerStatus: string;
    amountIdr: bigint; feeIdr: bigint | null; netIdr: bigint | null;
    counterparty: unknown; providerResponse: unknown; createdAt: Date;
  }): Promise<SubTxView> {
    let res;
    try {
      res = await this.withRetry(() => this.sac.txStatus(row.providerRef), "transaction status");
    } catch (err) {
      if (row.kind === "deposit" && row.providerStatus === "created" && err instanceof ProviderError && err.httpStatus === 404) {
        throw new BadRequestException("Not paid yet — open the DOKU payment page to pay, then check again");
      }
      throw this.mapError(err, "transaction status");
    }
    const status = mapSacStatus(res.latestTransactionStatus);
    // Checkout rows only (order-status unavailable): txStatus "settled" here
    // is settlement-side movement, never payment — record it as processing
    // so the legacy vocabulary can't read as payment-confirmed, and never
    // issue. The row stays open for order-status corroboration or the sweep.
    const updated = await this.markTx(row.id, status === "settled" ? "processing" : status, res.rawResponse);
    return (await this.attachFeeStatus([this.toTxView((await this.prisma.fiatProviderTransaction.findFirst({ where: { id: row.id, pid: row.pid } })) ?? updated)]))[0];
  }

  /**
   * Corroborate a Checkout payment against DOKU's order status (documented).
   * `paid` requires transaction.status === "SUCCESS" (FINAL = customer paid),
   * independent of Sub-Account settlement. Throws ProviderError (with raw
   * response) on transport/endpoint failure or unknown invoice — callers
   * decide fallback vs waiting. Never infers payment from anything else.
   */
  private async corroborateCheckoutPayment(invoiceNumber: string): Promise<{
    outcome: "paid" | "pending" | "expired" | "failed" | "unknown";
    paidAmount: bigint | null;
    raw: unknown;
  }> {
    const st = await this.checkout.checkOrderStatus(invoiceNumber);
    if (st.paid) return { outcome: "paid", paidAmount: st.paidAmount, raw: st.rawResponse };
    if (st.expired) return { outcome: "expired", paidAmount: st.paidAmount, raw: st.rawResponse };
    if (st.txStatus === "FAILED" || st.txStatus === "REFUNDED") {
      return { outcome: "failed", paidAmount: st.paidAmount, raw: st.rawResponse };
    }
    return { outcome: "pending", paidAmount: st.paidAmount, raw: st.rawResponse };
  }

  /**
   * Invoice amount-match: corroborated paid amount must equal OUR invoice
   * gross exactly. Returns true on match. Null (unparseable provider amount)
   * returns false without writing (retry later). Mismatch writes ledgerStatus
   * "blocked" for ops review and returns false — never round, never guess.
   */
  private async assertInvoiceAmountMatch(rowId: string, invoicedGross: bigint, paidAmount: bigint | null, providerRef: string): Promise<boolean> {
    if (paidAmount === null) {
      this.logger.warn(`issue skipped for ${providerRef}: unparseable corroborated amount`);
      return false;
    }
    if (paidAmount !== invoicedGross) {
      await this.prisma.fiatProviderTransaction.update({
        where: { id: rowId },
        data: {
          ledgerStatus: "blocked",
          counterparty: await this.counterpartyWith(rowId, { amountMismatch: paidAmount.toString() }),
        },
      }).catch(() => undefined);
      this.logger.error(`ISSUE BLOCKED amount mismatch for ${providerRef}: paid ${paidAmount} vs invoiced ${invoicedGross}`);
      return false;
    }
    return true;
  }

  /** Merge extra keys into a row's counterparty JSON (read-modify-write). */
  private async counterpartyWith(rowId: string, extra: Record<string, unknown>): Promise<Prisma.InputJsonValue> {
    const row = await this.prisma.fiatProviderTransaction.findUnique({ where: { id: rowId } }).catch(() => null);
    return json({ ...(((row?.counterparty ?? {}) as Record<string, unknown>)), ...extra });
  }

  async cancelTx(pid: string, id: string): Promise<SubTxView> {
    const row = await this.prisma.fiatProviderTransaction.findFirst({ where: { id, pid } });
    if (!row) throw new NotFoundException("Transaction not found");
    if (row.providerStatus !== "created") return this.toTxView(row);
    return this.toTxView(await this.markTx(row.id, "cancelled", { cancelledBy: pid }));
  }

  txs(pid: string): Promise<SubTxView[]> {
    return this.prisma.fiatProviderTransaction
      .findMany({ where: { pid }, orderBy: { createdAt: "desc" }, take: 50 })
      .then((rows) => this.attachFeeStatus(rows.map((r) => this.toTxView(r))));
  }

  // --- platform service fee (quote-only, versioned) ---
  //
  // The API quotes flat-5% fees and snapshots them on intent rows. The FEE
  // moves as Unified Ledger points to Treasury at issuance (deposit legs)
  // or at confirm time (transfer legs) — never as a post-settlement fiat
  // debit, and never via a fiat split rule (that would double-charge).
  // Legacy `kind = fee` rows ({parentRef}-FEE) remain readable for history;
  // attachFeeStatus below still surfaces their status, read-only.

  async feePolicy() {
    const policy = await this.activeFeePolicy();
    return { version: policy.version, percentBps: policy.percentBps, minIdr: policy.minIdr.toString(), maxIdr: policy.maxIdr.toString(), active: true };
  }

  async createFeePolicy(input: { percentBps: number; minIdr: string; maxIdr: string }) {
    const minIdr = BigInt(input.minIdr);
    const maxIdr = BigInt(input.maxIdr);
    // 0 = unbounded. A finite floor above a finite cap can never be satisfied.
    if (minIdr > 0n && maxIdr > 0n && minIdr > maxIdr) {
      throw new BadRequestException("minIdr cannot exceed maxIdr");
    }
    const max = await this.prisma.fiatFeePolicy.aggregate({ _max: { version: true } });
    const version = (max._max.version ?? 0) + 1;
    return this.prisma.$transaction(async (tx) => {
      await tx.fiatFeePolicy.updateMany({ where: { active: true }, data: { active: false } });
      const row = await tx.fiatFeePolicy.create({
        data: { version, percentBps: input.percentBps, minIdr, maxIdr, active: true },
      });
      return { version: row.version, percentBps: row.percentBps, minIdr: row.minIdr.toString(), maxIdr: row.maxIdr.toString(), active: row.active };
    });
  }

  // NOTE: settleFee / executeFeeLeg / autoSplitFee were removed here.
  // Fee settlement is DOKU-native per payment (split_rule_id). No API
  // fallback exists by design.

  // --- Unified Ledger issuance (backend-only) ---
  //
  // THE MODEL: POINT is not an app-invented balance. It lives on DOKU's
  // Unified Ledger. Payment confirmed → we call DOKU_NON_FIAT to move POINT
  // from the merchant SYSTEM_POINT account into the user's POINT account
  // (NET) and into Treasury (FEE). The PeridotID journal only RECORDS that
  // movement and reconstructs ownership; it is never the balance itself.
  // Therefore every points_issue/points_fee row must correspond to a REAL
  // DOKU movement, and the leg only becomes `issued` after DOKU corroborates
  // it (txStatus "00"). If DOKU cannot move POINT (SYSTEM_POINT/TOPUP not
  // provisioned → 4004203), we DEFER: no journal write, no fabricated
  // balance. Settlement of the fiat leg is backing and never gates this.
  //
  // SECURITY: these functions are the ONLY place points are ever issued, and
  // they run ONLY after server-side payment corroboration (Checkout order
  // SUCCESS + exact amount-match against the server-created invoice; VA only
  // behind PID_VA_ISSUANCE_ENABLED) AND Unified Ledger readiness
  // (PID_UNIFIED_LEDGER_ACTIVE + DOKU_SYSTEM_POINT_ACCOUNT_NO). No controller
  // route, SDK method, or wallet screen may call them — a CI guard fails the
  // build otherwise. User input creates invoices; only verified DOKU money
  // creates points.

  /**
   * Execute one DOKU_NON_FIAT point top-up under a deterministic ref.
   * Idempotent: settled/processing legs return as-is; 409 → corroborate.
   * Returns the leg status. Never throws for expected gateway states —
   * callers decide retry policy; unexpected errors still throw.
   */
  private async executePointTopup(input: {
    pid: string; providerRef: string; toPointAccount: string; amountIdr: bigint;
    kind: "points_issue" | "points_fee"; parentRef: string; source: string;
  }): Promise<"settled" | "processing" | "failed"> {
    // Resolve the DOKU funding account BEFORE any journal write: a missing
    // SYSTEM_POINT must defer (throw → caller defers), never leave an orphan
    // failed leg. Every points_issue/points_fee is a REAL DOKU movement.
    const systemPoint = this.systemPointAccount();
    const existing = await this.prisma.fiatProviderTransaction.findFirst({
      where: { kind: input.kind, providerRef: input.providerRef },
    });
    if (existing && ["settled", "processing"].includes(existing.providerStatus)) {
      return existing.providerStatus as "settled" | "processing";
    }
    const legRow = existing ?? (await this.prisma.fiatProviderTransaction.create({
      data: {
        pid: input.pid, accountId: input.toPointAccount, kind: input.kind, providerRef: input.providerRef,
        amountIdr: input.amountIdr, feeIdr: null, netIdr: input.amountIdr, providerStatus: "created",
        // Fee legs leave the depositor's ownership (they paid gross, kept
        // net) and land in Treasury; user legs credit the recipient.
        direction: input.kind === "points_fee" ? "out" : "in",
        sourceAccount: systemPoint, destAccount: input.toPointAccount,
        entryGroup: input.parentRef,
        ledgerRef: input.providerRef, ledgerStatus: "pending",
        counterparty: { parentRef: input.parentRef, currency: "POINT", source: input.source },
      },
    }));
    const settleAs = async (status: "settled" | "processing" | "failed", raw: unknown) => {
      await this.markTx(legRow.id, status, raw);
      await this.prisma.fiatProviderTransaction.update({
        where: { id: legRow.id },
        data: { ledgerStatus: status === "settled" ? "issued" : status },
      }).catch(() => undefined);
      return status;
    };
    try {
      const inquiry = await this.withRetry(
        () => this.sac.transferInquiry({
          partnerReferenceNo: input.providerRef, type: "DOKU_NON_FIAT", amountIdr: input.amountIdr,
          currency: "POINT", fromAccount: systemPoint, beneficiaryAccountNumber: input.toPointAccount,
          remark: `PID points ${input.kind === "points_fee" ? "treasury fee" : "deposit"} for ${input.parentRef}`,
        }),
        "points top-up inquiry",
      );
      const paid = await this.withRetry(
        () => this.sac.transferPayment({
          partnerReferenceNo: input.providerRef, referenceNo: inquiry.referenceNo, type: "DOKU_NON_FIAT",
          amountIdr: input.amountIdr, currency: "POINT", fromAccount: systemPoint,
          beneficiaryAccountNumber: input.toPointAccount,
          beneficiaryAccountName: inquiry.beneficiaryAccountName ?? input.toPointAccount,
        }),
        "points top-up payment",
      );
      // Top-up payment carries no status — corroborate, then adopt it.
      const st = await this.withRetry(() => this.sac.txStatus(input.providerRef), "points top-up status");
      const mapped = mapSacStatus(st.latestTransactionStatus);
      if (mapped === "settled" || mapped === "processing") {
        return settleAs(mapped, st.rawResponse ?? paid.rawResponse);
      }
      return settleAs("failed", st.rawResponse ?? paid.rawResponse);
    } catch (err) {
      if (err instanceof ProviderError && err.httpStatus === 409) {
        const st = await this.withRetry(() => this.sac.txStatus(input.providerRef), "points top-up status");
        const mapped = mapSacStatus(st.latestTransactionStatus);
        if (mapped === "settled" || mapped === "processing") return settleAs(mapped, st.rawResponse);
        return settleAs("failed", st.rawResponse);
      }
      await settleAs("failed", err).catch(() => undefined);
      this.logger.warn(`points top-up failed for ${input.providerRef}: ${String(err)?.slice(0, 200)}`);
      return "failed";
    }
  }

  /**
   * Issue spendable points for a PAID deposit: NET → user POINT account,
   * FEE → Treasury POINT account (two DOKU_NON_FIAT top-ups, deterministic
   * refs `{ref}-PTS` / `{ref}-PTS-FEE`). Backend-only — callers must have
   * corroborated payment server-side first; this function re-verifies the
   * corroborated gross against the invoice (amount-match) before issuing.
   * Idempotent and never-throwing: safe to call from webhook, sync, and
   * sweep paths. A failed Treasury leg leaves the parent `partial` for the
   * sweep to complete; the user leg is what unlocks the Saldo.
   */
  private async issuePointsForDeposit(rowId: string, source: string): Promise<void> {
    const pre = await this.prisma.fiatProviderTransaction.findUnique({ where: { id: rowId } }).catch(() => null);
    if (!pre || pre.kind !== "deposit") return;
    // Serialize per depositor: concurrent webhooks/syncs for the same deposit
    // must not interleave check-then-issue sequences (DOKU 409 would save us,
    // but one top-up call is strictly better than two).
    await this.withPidLocks([pre.pid], () => this.issuePointsForDepositInner(rowId, source)).catch((err) => {
      this.logger.warn(`issuePointsForDeposit failed: ${String(err)?.slice(0, 200)}`);
    });
  }

  private async issuePointsForDepositInner(rowId: string, source: string): Promise<void> {
    try {
      const row = await this.prisma.fiatProviderTransaction.findUnique({ where: { id: rowId } });
      // PAYMENT CONFIRMED → issue POINT. The gate reads payment truth only
      // (providerPaymentStatus, legacy fallback); settlement is
      // backing/reconciliation and never gates issuance.
      if (!row || row.kind !== "deposit" || !this.isPaymentConfirmedRow(row as never)) return;
      if (row.ledgerStatus === "issued") return; // already done — no double issue
      // Hard prerequisite (correction §6): Unified Ledger activation. Until
      // DOKU_NON_FIAT TOPUP + SYSTEM_POINT funding are live-verified, fail
      // safe here — before any DOKU call, zero writes, zero fabricated balance.
      // The flag only PERMITS the flow; it is not readiness by itself.
      if (!this.unifiedLedgerActive()) {
        this.logger.warn(`issue deferred for ${row.providerRef}: Unified Ledger not activated (PID_UNIFIED_LEDGER_ACTIVE)`);
        return;
      }
      // The flag alone cannot move money: DOKU must actually provide the
      // merchant SYSTEM_POINT account that funds DOKU_NON_FIAT top-ups.
      // Missing it means no real Unified Ledger movement is possible, so
      // defer with zero writes rather than write an orphan failed leg.
      if (!this.systemPointConfigured()) {
        this.logger.warn(`issue deferred for ${row.providerRef}: DOKU_SYSTEM_POINT_ACCOUNT_NO not configured (Unified Ledger provider dependency)`);
        return;
      }
      const cp = (row.counterparty ?? {}) as Record<string, any>;
      if (this.isCheckoutRow(cp)) {
        // Checkout rail: payment confirmation is Checkout transaction SUCCESS
        // (order status), re-verified here regardless of which path called us.
        // Sub-Account settlement state is never consulted for issuance.
        let corr: { outcome: string; paidAmount: bigint | null };
        try {
          corr = await this.withRetry(() => this.corroborateCheckoutPayment(row.providerRef), "issue corroboration");
        } catch (err) {
          this.logger.warn(`issue corroboration failed for ${row.providerRef}: ${String(err)?.slice(0, 200)}`);
          return;
        }
        if (corr.outcome !== "paid") return; // pending/expired/failed/unknown — nothing to issue
        if (!(await this.assertInvoiceAmountMatch(row.id, row.amountIdr, corr.paidAmount, row.providerRef))) return;
      } else {
        // VA rail: the SUCCESS-only payment notification is the provisional
        // payment signal; txStatus corroboration below is defense-in-depth.
        // Boundary (PROVIDER-DEP-01, sandbox-verify): whether txStatus "00"
        // alone ever means payment-received vs settlement-only for VA credits
        // is UNCONFIRMED — so a persisted SUCCESS notify is REQUIRED here,
        // and the VA kill-switch must be explicitly enabled. Rows whose only
        // evidence is txStatus-00 stay pending for ops review (visible via
        // pendingIssuance); nothing is inferred.
        if (cp.notifyTxStatus !== "SUCCESS") {
          this.logger.warn(`issue deferred for ${row.providerRef}: no SUCCESS payment notification on record`);
          return;
        }
        if (!this.vaIssuanceEnabled()) {
          this.logger.warn(`issue deferred for ${row.providerRef}: VA payment semantics unverified (PID_VA_ISSUANCE_ENABLED)`);
          return;
        }
        let st;
        try {
          st = await this.withRetry(() => this.sac.txStatus(row.providerRef), "issue corroboration");
        } catch (err) {
          this.logger.warn(`issue corroboration failed for ${row.providerRef}: ${String(err)?.slice(0, 200)}`);
          return;
        }
        if (mapSacStatus(st.latestTransactionStatus) !== "settled") return; // not corroborated — nothing to issue
        // Amount-match: the paid amount must equal OUR invoice gross. A mismatch
        // means tampering or a DOKU-side anomaly — block issuance for ops review.
        const paidRaw = (st.amount as { value?: string } | undefined)?.value;
        if (paidRaw != null) {
          try {
            const paid = parseIdrStrict(paidRaw, "corroborated amount");
            if (paid !== row.amountIdr) {
              await this.prisma.fiatProviderTransaction.update({
                where: { id: row.id },
                data: {
                  ledgerStatus: "blocked",
                  counterparty: json({ ...((row.counterparty ?? {}) as Record<string, unknown>), amountMismatch: paid.toString() }),
                },
              }).catch(() => undefined);
              this.logger.error(`ISSUE BLOCKED amount mismatch for ${row.providerRef}: paid ${paid} vs invoiced ${row.amountIdr}`);
              return;
            }
          } catch {
            // Unparseable corroborated amount — do not issue blindly.
            this.logger.warn(`issue skipped for ${row.providerRef}: unparseable corroborated amount`);
            return;
          }
        }
      }
      const cpq = (row.counterparty ?? {}) as Record<string, any>;
      const net = typeof cpq.netQuote === "string" && /^\d+$/.test(cpq.netQuote)
        ? BigInt(cpq.netQuote)
        : (row.netIdr ?? row.amountIdr);
      const fee = typeof cpq.feeQuote === "string" && /^\d+$/.test(cpq.feeQuote)
        ? BigInt(cpq.feeQuote)
        : (row.feeIdr ?? 0n);
      const userPoint = await this.pointAccountFor(row.pid, "Depositor").catch(() => undefined);
      if (!userPoint) {
        this.logger.warn(`issue deferred for ${row.providerRef}: depositor POINT account unknown`);
        return;
      }
      const userLeg = await this.executePointTopup({
        pid: row.pid, providerRef: `${row.providerRef}-PTS`, toPointAccount: userPoint,
        amountIdr: net, kind: "points_issue", parentRef: row.providerRef, source,
      });
      if (userLeg !== "settled") {
        await this.prisma.fiatProviderTransaction.update({
          where: { id: row.id },
          data: { ledgerStatus: "failed", ledgerRef: `${row.providerRef}-PTS` },
        }).catch(() => undefined);
        return;
      }
      let feeLeg: "settled" | "processing" | "failed" = "settled";
      if (fee > 0n) {
        const treasuryPoint = await this.treasuryPointAccount().catch((err) => {
          this.logger.warn(`treasury leg deferred for ${row.providerRef}: ${String(err)?.slice(0, 160)}`);
          return undefined;
        });
        feeLeg = treasuryPoint
          ? await this.executePointTopup({
            pid: row.pid, providerRef: `${row.providerRef}-PTS-FEE`, toPointAccount: treasuryPoint,
            amountIdr: fee, kind: "points_fee", parentRef: row.providerRef, source,
          })
          : "failed";
      }
      await this.prisma.fiatProviderTransaction.update({
        where: { id: row.id },
        data: {
          ledgerStatus: feeLeg === "settled" ? "issued" : "partial",
          ledgerRef: `${row.providerRef}-PTS`,
          settlementStatus: row.settlementStatus ?? "pending",
        },
      }).catch(() => undefined);
      await this.security.log(row.pid, "fiat.points.issued", { providerRef: row.providerRef, net: net.toString(), fee: fee.toString() }).catch(() => undefined);
    } catch (err) {
      this.logger.warn(`issuePointsForDeposit failed: ${String(err)?.slice(0, 200)}`);
    }
  }

  /**
   * Claw back issued points after a failed/charged-back payment (admin-only
   * entrypoint). Uses POINT debit (partial, retry-safe) — never void-topup
   * except full-exact reversals. Ref `{parent}-CLAWBACK-{n}`.
   */
  async clawbackPoints(input: { transactionId: string; amountIdr: string; reason?: string }) {
    const amount = this.parseGross(input.amountIdr);
    const parent = await this.prisma.fiatProviderTransaction.findUnique({ where: { id: input.transactionId } });
    if (!parent || parent.kind !== "deposit") throw new NotFoundException("Deposit not found");
    if (!["issued", "partial"].includes(parent.ledgerStatus ?? "")) {
      throw new BadRequestException("Nothing issued to claw back — ledgerStatus is " + (parent.ledgerStatus ?? "unset"));
    }
    return this.withPidLocks([parent.pid], () => this.clawbackPointsDirect(parent, amount, input.reason));
  }

  /**
   * Propose a clawback candidate after a corroborated reversal signal — creates
   * the journal row WITHOUT executing any debit. The candidate waits in
   * ledgerStatus "review" for explicit admin approval (approveClawback).
   * Idempotent per (parentRef, signal): repeat signals return the existing
   * candidate instead of forking duplicates. No automatic clawback exists —
   * reversal automation ends here by design (correction §8).
   * Exactness rule: when the corroborated reversal amount is known and
   * differs from the issued NET, the reversal is ambiguous/partial → NO
   * candidate is created (returns null, stays blocked for manual ops via
   * direct clawbackPoints). Only exact (or amount-unknown) reversals become
   * candidates, always for the exact issued NET. Never throws for "nothing
   * to do" — returns null so webhook/sync/reconcile paths stay quiet.
   */
  async proposeClawback(parentProviderRef: string, reason: string, signal: string, reversalAmountIdr?: bigint | null): Promise<{ id: string; providerRef: string } | null> {
    const parent = await this.prisma.fiatProviderTransaction.findUnique({ where: { providerRef: parentProviderRef } }).catch(() => null);
    if (!parent || parent.kind !== "deposit") return null;
    if (!["issued", "partial"].includes(parent.ledgerStatus ?? "")) return null; // nothing issued — nothing to claw
    const existing = await this.prisma.fiatProviderTransaction.findFirst({
      where: { kind: "points_clawback", counterparty: { path: ["parentRef"], equals: parentProviderRef } },
    }).catch(() => null);
    if (existing) {
      const existingSignal = ((existing.counterparty ?? {}) as Record<string, any>).signal;
      if (existingSignal === signal || (existing.ledgerStatus ?? "") === "review") return { id: existing.id, providerRef: existing.providerRef };
    }
    const cp = (parent.counterparty ?? {}) as Record<string, any>;
    const exactNet = typeof cp.netQuote === "string" && /^\d+$/.test(cp.netQuote)
      ? BigInt(cp.netQuote)
      : (parent.netIdr ?? parent.amountIdr);
    // Partial/ambiguous reversal (known amount ≠ issued NET) → blocked for
    // manual ops. No candidate: an auto-created exact-NET candidate would
    // over-claw on approval.
    if (reversalAmountIdr != null && reversalAmountIdr !== exactNet) {
      this.logger.warn(`clawback blocked for ${parentProviderRef}: reversal ${reversalAmountIdr} != issued NET ${exactNet} — manual review`);
      await this.security.log(parent.pid, "fiat.points.clawback_blocked", {
        providerRef: parentProviderRef, signal, reversal: reversalAmountIdr.toString(), exactNet: exactNet.toString(),
      }).catch(() => undefined);
      return null;
    }
    const prior = await this.prisma.fiatProviderTransaction.findMany({
      where: { kind: "points_clawback", providerRef: { startsWith: `${parentProviderRef}-CLAWBACK` } },
      select: { amountIdr: true },
    }).catch(() => []);
    const providerRef = `${parentProviderRef}-CLAWBACK-${prior.length + 1}`;
    const userPoint = await this.pointAccountFor(parent.pid, "Depositor").catch(() => undefined);
    const row = await this.prisma.fiatProviderTransaction.create({
      data: {
        pid: parent.pid, accountId: userPoint ?? undefined, kind: "points_clawback", providerRef, amountIdr: exactNet,
        feeIdr: null, netIdr: exactNet, providerStatus: "created",
        direction: "out", sourceAccount: userPoint, destAccount: undefined, entryGroup: providerRef,
        ledgerRef: providerRef, ledgerStatus: "review",
        counterparty: {
          parentRef: parentProviderRef, currency: "POINT", signal, reason,
          exactNet: exactNet.toString(), status: "awaiting-review",
          ...(reversalAmountIdr != null ? { reversalAmountIdr: reversalAmountIdr.toString() } : {}),
        },
      },
    });
    await this.security.log(parent.pid, "fiat.points.clawback_proposed", { providerRef, signal, reason: reason.slice(0, 160) }).catch(() => undefined);
    return { id: row.id, providerRef };
  }

  /**
   * Approve a review-pending clawback candidate: executes the POINT debit.
   * The only path that moves clawback money — reversal signals only ever
   * create candidates (proposeClawback). Direct admin clawbackPoints below
   * shares the same executor.
   */
  async approveClawback(id: string): Promise<SubTxView> {
    const row = await this.prisma.fiatProviderTransaction.findUnique({ where: { id } });
    if (!row || row.kind !== "points_clawback") throw new NotFoundException("Clawback candidate not found");
    if ((row.ledgerStatus ?? "") !== "review" || row.providerStatus !== "created") {
      throw new BadRequestException("Clawback candidate is no longer awaiting review");
    }
    const parent = await this.prisma.fiatProviderTransaction.findFirst({
      where: { kind: "deposit", providerRef: ((row.counterparty ?? {}) as Record<string, any>).parentRef ?? "" },
    });
    if (!parent) throw new NotFoundException("Parent deposit not found");
    return this.withPidLocks([parent.pid], () => this.executeClawbackRow({ ...row, counterparty: row.counterparty ?? {} }));
  }

  private async executeClawbackRow(clawRow: {
    id: string; pid: string; kind: string; providerRef: string; amountIdr: bigint; counterparty: unknown;
  }): Promise<SubTxView> {
    const cp = (clawRow.counterparty ?? {}) as Record<string, any>;
    const parent = await this.prisma.fiatProviderTransaction.findFirst({
      where: { kind: "deposit", providerRef: typeof cp.parentRef === "string" ? cp.parentRef : "" },
    });
    const userPoint = await this.pointAccountFor(clawRow.pid, "Depositor");
    const amount = clawRow.amountIdr;
    const providerRef = clawRow.providerRef;
    try {
      const res = await this.withRetry(
        () => this.sac.debit({
          partnerReferenceNo: providerRef, fromAccount: userPoint, amountIdr: amount,
          currency: "POINT", description: `PID clawback for ${typeof cp.parentRef === "string" ? cp.parentRef : providerRef}${cp.reason ? `: ${cp.reason}` : ""}`.slice(0, 128),
        }),
        "clawback debit",
      );
      const status = mapSacStatus(res.latestTransactionStatus ?? "03");
      const settledClaw = await this.markTx(clawRow.id, status, res.rawResponse);
      await this.prisma.fiatProviderTransaction.update({
        where: { id: clawRow.id },
        data: { ledgerStatus: status === "settled" ? "issued" : status },
      }).catch(() => undefined);
      if (status !== "failed" && parent) {
        const prior = await this.prisma.fiatProviderTransaction.findMany({
          where: { kind: "points_clawback", providerRef: { startsWith: `${parent.providerRef}-CLAWBACK` } },
          select: { providerRef: true, amountIdr: true, providerStatus: true },
        }).catch(() => []);
        // Exclude this leg (already journaled) to avoid double counting.
        const recovered = prior
          .filter((r) => r.providerRef !== providerRef && r.providerStatus !== "failed")
          .reduce((s, r) => s + r.amountIdr, 0n) + amount;
        const net = parent.netIdr ?? parent.amountIdr;
        await this.prisma.fiatProviderTransaction.update({
          where: { id: parent.id },
          data: { ledgerStatus: recovered >= net ? "clawed_back" : "partial" },
        }).catch(() => undefined);
      }
      await this.security.log(clawRow.pid, "fiat.points.clawback", { providerRef, amount: amount.toString() }).catch(() => undefined);
      return this.toTxView({ ...settledClaw, feeIdr: null, netIdr: amount });
    } catch (err) {
      await this.markTx(clawRow.id, "failed", err);
      throw this.mapError(err, "clawback");
    }
  }
  /**
   * Direct admin clawback: explicit operator action with amount + reason
   * (NOT a reversal signal — those go through proposeClawback). Creates the
   * row then executes via the shared executor. Kept for manual ops; reversal
   * automation must use propose → approve instead.
   */
  async clawbackPointsDirect(parent: { id: string; pid: string; providerRef: string }, amount: bigint, reason?: string): Promise<SubTxView> {
    const userPoint = await this.pointAccountFor(parent.pid, "Depositor");
    const prior = await this.prisma.fiatProviderTransaction.findMany({
      where: { kind: "points_clawback", providerRef: { startsWith: `${parent.providerRef}-CLAWBACK` } },
      select: { amountIdr: true },
    }).catch(() => []);
    const providerRef = `${parent.providerRef}-CLAWBACK-${prior.length + 1}`;
    const clawRow = await this.prisma.fiatProviderTransaction.create({
      data: {
        pid: parent.pid, accountId: userPoint, kind: "points_clawback", providerRef, amountIdr: amount,
        feeIdr: null, netIdr: amount, providerStatus: "created",
        direction: "out", sourceAccount: userPoint, destAccount: this.systemPointAccount(), entryGroup: providerRef,
        ledgerRef: providerRef, ledgerStatus: "pending",
        counterparty: { parentRef: parent.providerRef, currency: "POINT", reason: reason ?? null, source: "admin" },
      },
    });
    return this.executeClawbackRow({ ...clawRow, counterparty: clawRow.counterparty ?? {} });
  }

  // --- redemption saga (PTS→fiat, feature-flagged) ---
  //
  // Claimant = current PTS owner per journal replay. NEVER the original
  // depositor, NEVER the holder of the original fiat. Flow:
  //   request → burn PTS (POINT debit → SYSTEM_POINT, extinguished) →
  //   ensure pool liquidity (consolidate if needed, all journaled) →
  //   BANK_ACCOUNT payout from the Treasury/operating pool → completed.
  // Crash safety: burn-without-payout is completed by the sweep (same payout
  // ref); requested-without-burn expires and releases. Settlement never
  // touches redemption rows. Disabled unless PID_REDEMPTION_ENABLED=true
  // AND the BANK_ACCOUNT + consolidation path is sandbox-verified.

  private redemptionEnabled(): boolean {
    return this.config.get<string>("PID_REDEMPTION_ENABLED", "false") === "true";
  }

  /**
   * Kill-switch for unexplained backing discrepancies. In-memory by design:
   * restarts clear it, but every sweep re-evaluates the aggregate and
   * re-halts on a persistent discrepancy — a restart can never silently
   * bless a broken ledger. All transitions are security-logged.
   */
  private redemptionHalted = false;

  setRedemptionHalt(halt: boolean, reason: string): { halted: boolean } {
    this.redemptionHalted = halt;
    this.logger[halt ? "error" : "warn"](`redemption halt ${halt ? "ENGAGED" : "cleared"}: ${reason.slice(0, 200)}`);
    return { halted: this.redemptionHalted };
  }

  /** Treasury/operating IDR pool (payout liquidity). Env preferred, else
   *  resolved from the Treasury profile (cached 5 min). */
  private treasuryIdrCache: { value: string; exp: number } | null = null;
  private async treasuryIdrAccount(): Promise<string> {
    const env = this.config.get<string>("DOKU_TREASURY_ACCOUNT_NO", "");
    if (env) return env;
    if (this.treasuryIdrCache && Date.now() < this.treasuryIdrCache.exp) return this.treasuryIdrCache.value;
    const profileId = this.config.get<string>("DOKU_TREASURY_PROFILE_ID", "");
    if (!profileId) throw new ServiceUnavailableException("Treasury IDR pool not configured — set DOKU_TREASURY_ACCOUNT_NO");
    let bal;
    try {
      bal = await this.withRetry(() => this.sac.balance(profileId), "treasury idr balance");
    } catch (err) {
      throw this.mapError(err, "treasury idr balance");
    }
    const idr = bal.accounts.find((a) => a.type === IDR_ACCOUNT)?.accountNo;
    if (!idr) throw new ServiceUnavailableException("Treasury IDR account not found on its profile");
    this.treasuryIdrCache = { value: idr, exp: Date.now() + 5 * 60_000 };
    return idr;
  }

  async requestRedemption(pid: string, input: {
    amountIdr: string; bankCode: string; bankAccountNumber: string; bankAccountName: string;
    channel?: "BI_FAST" | "ONLINE"; clientId?: string;
  }): Promise<SubTxView> {
    if (!this.redemptionEnabled()) throw new ForbiddenException("Withdrawals are disabled");
    if (this.redemptionHalted) {
      throw new ServiceUnavailableException("Withdrawals halted pending ops review of a backing discrepancy — try again later");
    }
    const amount = this.parseGross(input.amountIdr);
    return this.withPidLocks([pid], () => this.redemptionInner(pid, amount, input));
  }

  private async redemptionInner(
    pid: string, amount: bigint,
    input: { bankCode: string; bankAccountNumber: string; bankAccountName: string; channel?: "BI_FAST" | "ONLINE"; clientId?: string },
  ): Promise<SubTxView> {
    // Claimant check from REPLAY, not from any fiat location.
    const owned = await this.replayedBalance(pid);
    if (owned < amount) throw new BadRequestException(`Insufficient redeemable balance (owns ${owned}, requested ${amount})`);
    // Withdraw fee (bank payout): global + app (when an app context is given).
    // Application to the payout leg is done when the redemption rail is
    // reworked for the internal ledger; snapshot it now so intent is recorded.
    const { globalFee, appFee, appId, appOwnerPid } = await this.ledger.quoteFees(input.clientId ?? null, "withdraw", amount);
    const totalFee = globalFee + appFee;
    const providerRef = buildInvoiceNumber("RD");
    const parent = await this.prisma.fiatProviderTransaction.create({
      data: {
        pid, accountId: null, kind: "redemption", providerRef, amountIdr: amount,
        feeIdr: totalFee, netIdr: amount - totalFee, providerStatus: "created",
        ledgerStatus: "requested",
        counterparty: {
          bankCode: input.bankCode, bankAccountNumber: input.bankAccountNumber,
          bankAccountName: input.bankAccountName, channel: input.channel ?? "BI_FAST",
          feeQuote: globalFee.toString(),
          ...(appId && appOwnerPid ? { appId, appOwnerPid, appFeeQuote: appFee.toString() } : {}),
        },
      },
    });
    try {
      // 1. Burn: POINT debit retires the claim to SYSTEM_POINT. Extinguished
      //    only when settled — a failed burn releases the request, nothing lost.
      const userPoint = await this.pointAccountFor(pid, "Claimant");
      const burnRef = `${providerRef}-BURN`;
      const burnRow = await this.prisma.fiatProviderTransaction.create({
        data: {
          pid, accountId: userPoint, kind: "points_redeem", providerRef: burnRef, amountIdr: amount,
          feeIdr: null, netIdr: amount, providerStatus: "created",
          direction: "out", sourceAccount: userPoint, destAccount: this.systemPointAccount(), entryGroup: providerRef,
          ledgerRef: burnRef, ledgerStatus: "pending", extinguished: false,
          counterparty: { parentRef: providerRef, currency: "POINT" },
        },
      });
      let burnStatus: string;
      try {
        const burn = await this.withRetry(
          () => this.sac.debit({
            partnerReferenceNo: burnRef, fromAccount: userPoint, amountIdr: amount,
            currency: "POINT", description: `PID redemption burn for ${providerRef}`.slice(0, 128),
          }),
          "redemption burn",
        );
        burnStatus = mapSacStatus(burn.latestTransactionStatus ?? "03");
      } catch (err) {
        if (err instanceof ProviderError && err.httpStatus === 409) {
          const st = await this.withRetry(() => this.sac.txStatus(burnRef), "burn status");
          burnStatus = mapSacStatus(st.latestTransactionStatus);
          await this.markTx(burnRow.id, burnStatus, st.rawResponse);
        } else {
          await this.markTx(burnRow.id, "failed", err);
          await this.markTx(parent.id, "failed", err);
          await this.prisma.fiatProviderTransaction.update({
            where: { id: parent.id }, data: { ledgerStatus: "failed" },
          }).catch(() => undefined);
          throw this.mapError(err, "redemption burn");
        }
      }
      if (burnStatus !== "settled") {
        await this.markTx(parent.id, burnStatus === "failed" ? "failed" : "processing", { burnRef });
        await this.prisma.fiatProviderTransaction.update({
          where: { id: parent.id }, data: { ledgerStatus: burnStatus === "failed" ? "failed" : "burned" },
        }).catch(() => undefined);
        if (burnStatus === "failed") throw new ServiceUnavailableException("Redemption burn failed — request released, balance untouched");
        return this.toTxView(await this.prisma.fiatProviderTransaction.findUnique({ where: { id: parent.id } }).then((r) => r!));
      }
      await this.markTx(burnRow.id, "settled", { extinguished: true });
      await this.prisma.fiatProviderTransaction.update({
        where: { id: burnRow.id }, data: { extinguished: true, ledgerStatus: "issued" },
      }).catch(() => undefined);
      await this.prisma.fiatProviderTransaction.update({
        where: { id: parent.id }, data: { ledgerStatus: "burned" },
      }).catch(() => undefined);
      // 2. Liquidity, then payout. Crash between burn and payout is completed
      //    by the sweep under the SAME payout ref — never re-burned.
      await this.executeRedemptionPayout(parent.id);
      const fresh = await this.prisma.fiatProviderTransaction.findUnique({ where: { id: parent.id } });
      return this.toTxView(fresh ?? parent as never);
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof ServiceUnavailableException || err instanceof ForbiddenException) throw err;
      await this.markTx(parent.id, "failed", err);
      throw this.mapError(err, "redemption");
    }
  }

  /** Replay one PID's outstanding (claimant check). Live DOKU is NOT
   *  consulted here — replay IS the ownership source; recon asserts equality. */
  private async replayedBalance(pid: string): Promise<bigint> {
    const rows = await this.prisma.fiatProviderTransaction.findMany({
      where: { pid }, take: 5000, orderBy: { replaySeq: "asc" },
    });
    const replayed = replayJournal(rows.map((r) => ({
      kind: r.kind, pid: r.pid, providerRef: r.providerRef, providerStatus: r.providerStatus,
      amountIdr: r.amountIdr, direction: r.direction, entryGroup: r.entryGroup,
      extinguished: r.extinguished, counterparty: (r.counterparty ?? null) as Record<string, unknown> | null,
      replaySeq: r.replaySeq,
    })));
    return replayed.balances.get(pid) ?? 0n;
  }

  /**
   * Ensure pool liquidity then execute the BANK_ACCOUNT payout for a burned
   * redemption. Idempotent per payout ref; safe to re-run after a crash.
   */
  private async executeRedemptionPayout(parentId: string): Promise<void> {
    const parent = await this.prisma.fiatProviderTransaction.findUnique({ where: { id: parentId } });
    if (!parent || parent.kind !== "redemption") return;
    const cp = (parent.counterparty ?? {}) as Record<string, any>;
    const payoutRef = `${parent.providerRef}-PAY`;
    const existing = await this.prisma.fiatProviderTransaction.findFirst({ where: { kind: "fiat_payout", providerRef: payoutRef } });
    if (existing && ["settled", "processing"].includes(existing.providerStatus)) {
      await this.prisma.fiatProviderTransaction.update({
        where: { id: parent.id }, data: { ledgerStatus: "completed", providerStatus: existing.providerStatus },
      }).catch(() => undefined);
      return;
    }
    await this.ensurePoolLiquidity(parent.amountIdr);
    const pool = await this.treasuryIdrAccount();
    const legRow = existing ?? (await this.prisma.fiatProviderTransaction.create({
      data: {
        pid: parent.pid, accountId: pool, kind: "fiat_payout", providerRef: payoutRef, amountIdr: parent.amountIdr,
        feeIdr: null, netIdr: parent.amountIdr, providerStatus: "created",
        direction: "out", sourceAccount: pool, destAccount: `BANK:${cp.bankCode}:${cp.bankAccountNumber}`,
        entryGroup: parent.providerRef, ledgerRef: payoutRef, ledgerStatus: "pending",
        counterparty: { parentRef: parent.providerRef, bankCode: cp.bankCode, bankAccountNumber: cp.bankAccountNumber, bankAccountName: cp.bankAccountName, channel: cp.channel ?? "BI_FAST" },
      },
    }));
    try {
      const inquiry = await this.withRetry(
        () => this.sac.transferInquiry({
          partnerReferenceNo: payoutRef, type: "BANK_ACCOUNT", amountIdr: parent.amountIdr,
          fromAccount: pool, beneficiaryAccountNumber: String(cp.bankAccountNumber),
          beneficiaryBankCode: String(cp.bankCode), channel: (cp.channel ?? "BI_FAST") as "BI_FAST" | "ONLINE",
          remark: `PID redemption ${parent.providerRef}`,
        }),
        "payout inquiry",
      );
      const paid = await this.withRetry(
        () => this.sac.transferPayment({
          partnerReferenceNo: payoutRef, referenceNo: inquiry.referenceNo, type: "BANK_ACCOUNT",
          amountIdr: parent.amountIdr, fromAccount: pool,
          beneficiaryAccountNumber: String(cp.bankAccountNumber),
          beneficiaryAccountName: String(cp.bankAccountName ?? inquiry.beneficiaryAccountName ?? cp.bankAccountNumber),
          beneficiaryBankCode: String(cp.bankCode), channel: (cp.channel ?? "BI_FAST") as "BI_FAST" | "ONLINE",
        }),
        "payout payment",
      );
      const st = await this.withRetry(() => this.sac.txStatus(payoutRef), "payout status").catch(() => null);
      const status = st ? mapSacStatus(st.latestTransactionStatus) : "processing";
      await this.markTx(legRow.id, status, paid.rawResponse);
      await this.prisma.fiatProviderTransaction.update({
        where: { id: parent.id },
        data: {
          providerStatus: status,
          ledgerStatus: status === "settled" ? "completed" : status === "failed" ? "payout_failed" : "burned",
        },
      }).catch(() => undefined);
      await this.security.log(parent.pid, "fiat.redemption.payout", { providerRef: payoutRef, status }).catch(() => undefined);
    } catch (err) {
      if (err instanceof ProviderError && err.httpStatus === 409) {
        const st = await this.withRetry(() => this.sac.txStatus(payoutRef), "payout status");
        const status = mapSacStatus(st.latestTransactionStatus);
        await this.markTx(legRow.id, status, st.rawResponse);
        await this.prisma.fiatProviderTransaction.update({
          where: { id: parent.id },
          data: { providerStatus: status, ledgerStatus: status === "settled" ? "completed" : "payout_failed" },
        }).catch(() => undefined);
        return;
      }
      await this.markTx(legRow.id, "failed", err);
      await this.prisma.fiatProviderTransaction.update({
        where: { id: parent.id }, data: { providerStatus: "failed", ledgerStatus: "payout_failed" },
      }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Pool liquidity: fast path when the Treasury/operating IDR pool already
   * covers the payout; otherwise consolidate available IDR from backing-rich
   * sub-accounts via journaled DOKU_SUB_ACCOUNT transfers (real DOKU
   * movements, never simulated). Claimant-local fiat is only the cheapest
   * first candidate — never a requirement.
   */
  private async ensurePoolLiquidity(amount: bigint): Promise<void> {
    const pool = await this.treasuryIdrAccount();
    const poolProfile = this.config.get<string>("DOKU_TREASURY_PROFILE_ID", "");
    const poolLive = async (): Promise<bigint> => {
      if (!poolProfile) {
        const row = await this.prisma.fiatProviderAccount.findFirst({ where: { providerAccountId: pool } }).catch(() => null);
        if (row?.lastBalance != null) { try { return parseIdrStrict(row.lastBalance, "pool cache"); } catch { /* fall through */ } }
        throw new ServiceUnavailableException("Pool live balance unavailable — set DOKU_TREASURY_PROFILE_ID");
      }
      const bal = await this.withRetry(() => this.sac.balance(poolProfile), "pool balance");
      const idr = bal.accounts.find((a) => a.type === IDR_ACCOUNT);
      return parseIdrStrict(idr?.available ?? "0", "pool balance");
    };
    if (await poolLive().catch(() => 0n) >= amount) return;
    // Consolidate from backing-rich accounts (cached balances first).
    const candidates = await this.prisma.fiatProviderAccount.findMany({
      where: { provider: PROVIDER, accountStatus: "active", providerAccountId: { not: pool } },
      orderBy: { lastBalanceAt: "desc" }, take: 10,
    });
    let covered = 0n;
    for (const c of candidates) {
      if (covered >= amount) break;
      if (!c.providerAccountId) continue;
      const need = amount - covered;
      const ref = buildInvoiceNumber("CN");
      try {
        const inquiry = await this.withRetry(
          () => this.sac.transferInquiry({
            partnerReferenceNo: ref, type: "DOKU_SUB_ACCOUNT", amountIdr: need,
            fromAccount: c.providerAccountId as string, beneficiaryAccountNumber: pool,
            remark: "PID liquidity consolidation",
          }),
          "consolidation inquiry",
        );
        const paid = await this.withRetry(
          () => this.sac.transferPayment({
            partnerReferenceNo: ref, referenceNo: inquiry.referenceNo, type: "DOKU_SUB_ACCOUNT",
            amountIdr: need, fromAccount: c.providerAccountId as string, beneficiaryAccountNumber: pool,
            beneficiaryAccountName: inquiry.beneficiaryAccountName ?? pool,
          }),
          "consolidation payment",
        );
        await this.prisma.fiatProviderTransaction.create({
          data: {
            pid: c.pid, accountId: c.providerAccountId, kind: "fiat_consolidation", providerRef: ref,
            amountIdr: need, feeIdr: null, netIdr: need, providerStatus: "processing",
            direction: "out", sourceAccount: c.providerAccountId, destAccount: pool, entryGroup: ref,
            ledgerRef: ref, ledgerStatus: "issued", counterparty: { source: "consolidation", destination: "treasury-pool" },
            providerResponse: json(paid.rawResponse),
          },
        }).catch(() => undefined);
        covered += need;
      } catch (err) {
        this.logger.warn(`consolidation from ${c.pid} failed: ${String(err)?.slice(0, 160)}`);
      }
    }
    if (await poolLive().catch(() => 0n) < amount) {
      throw new ServiceUnavailableException("Insufficient pool liquidity — consolidation could not cover the payout");
    }
  }

  /**
   * Sweep recovery for the redemption saga: burned-without-payout resumes the
   * payout under the same ref; requested-without-burn older than 15 minutes
   * expires (releases the request — nothing moved). Returns counts.
   */
  private async recoverRedemptions(): Promise<{ resumed: number; expired: number }> {
    let resumed = 0;
    let expired = 0;
    const open = await this.prisma.fiatProviderTransaction.findMany({
      where: { kind: "redemption", providerStatus: { in: ["created", "processing"] } },
      take: 50,
    });
    for (const r of open) {
      const ageMs = Date.now() - new Date(r.createdAt).getTime();
      if ((r.ledgerStatus ?? "") === "burned" || (r.ledgerStatus ?? "") === "payout_failed") {
        try {
          await this.executeRedemptionPayout(r.id);
          resumed++;
        } catch (err) {
          this.logger.warn(`redemption resume failed for ${r.providerRef}: ${String(err)?.slice(0, 160)}`);
        }
      } else if (ageMs > 15 * 60_000) {
        await this.markTx(r.id, "cancelled", { expired: true }).catch(() => undefined);
        await this.prisma.fiatProviderTransaction.update({
          where: { id: r.id }, data: { ledgerStatus: "expired" },
        }).catch(() => undefined);
        expired++;
      }
    }
    return { resumed, expired };
  }

  // --- debits (programmatic deduction; credit side filled in by DOKU) ---

  async debit(pid: string, amountIdr: string, description?: string): Promise<SubTxView> {
    const amount = this.parseGross(amountIdr);
    const account = await this.requireActive(pid);
    const fromAccount = account.providerAccountId ?? undefined;
    if (!fromAccount) throw new ServiceUnavailableException("IDR account unknown");
    const providerRef = buildInvoiceNumber("SD");
    const row = await this.prisma.fiatProviderTransaction.create({
      data: { pid, accountId: fromAccount, kind: "debit", providerRef, amountIdr: amount },
    });
    try {
      const res = await this.withRetry(
        () => this.sac.debit({ partnerReferenceNo: providerRef, fromAccount, amountIdr: amount, description }),
        "debit",
      );
      const updated = await this.markTx(row.id, mapSacStatus(res.latestTransactionStatus ?? "03"), res.rawResponse);
      await this.security.log(pid, "fiat.subaccount.debit", { providerRef }).catch(() => undefined);
      return this.toTxView(updated);
    } catch (err) {
      await this.markTx(row.id, "failed", err);
      throw this.mapError(err, "debit");
    }
  }

  async debitCancel(pid: string, id: string, refundAmountIdr: string, reason?: string): Promise<SubTxView> {
    const row = await this.prisma.fiatProviderTransaction.findFirst({ where: { id, pid, kind: "debit" } });
    if (!row) throw new NotFoundException("Debit not found");
    const refund = this.parseGross(refundAmountIdr);
    if (refund > row.amountIdr) throw new BadRequestException("Refund must be within the original amount");
    const providerRef = buildInvoiceNumber("SC");
    const cancelRow = await this.prisma.fiatProviderTransaction.create({
      data: { pid, accountId: row.accountId, kind: "debit_cancel", providerRef, amountIdr: refund, counterparty: { originalRef: row.providerRef } },
    });
    try {
      const r = (row.providerResponse ?? {}) as Record<string, any>;
      const res = await this.withRetry(
        () => this.sac.debitCancel({
          partnerReferenceNo: providerRef,
          originalPartnerReferenceNo: row.providerRef,
          refundAmountIdr: refund,
          originalReferenceNo: r?.referenceNo ? String(r.referenceNo) : undefined,
          reason,
        }),
        "debit cancel",
      );
      return this.toTxView(await this.markTx(cancelRow.id, mapSacStatus(res.latestTransactionStatus ?? "03"), res.rawResponse));
    } catch (err) {
      await this.markTx(cancelRow.id, "failed", err);
      throw this.mapError(err, "debit cancel");
    }
  }

  /** Admin: create an automated split rule (applies at settlement, on net). */
  async createSplitRule(transactionType: string, rules: { type: "PERCENTAGE" | "FLAT"; value: number; currency?: string; accountNumber: number }[]) {
    try {
      return await this.sac.createSplitRule({ transactionType, rules });
    } catch (err) {
      throw this.mapError(err, "split rule");
    }
  }

  /** Admin read-model for the webhook inbox (received vs applied). */
  webhookEvents(status?: string) {
    return this.prisma.fiatWebhookEvent.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  /**
   * Admin: immutable journal export for one PID (replaySeq order) plus the
   * replay verdict — answers "exactly which claims does this user own".
   */
  async adminJournal(pid: string) {
    const rows = await this.prisma.fiatProviderTransaction.findMany({
      where: { pid }, orderBy: { replaySeq: "asc" }, take: 1000,
    });
    const replayed = replayJournal(rows.map((r) => ({
      kind: r.kind, pid: r.pid, providerRef: r.providerRef, providerStatus: r.providerStatus,
      amountIdr: r.amountIdr, direction: r.direction, entryGroup: r.entryGroup,
      extinguished: r.extinguished, counterparty: (r.counterparty ?? null) as Record<string, unknown> | null,
      replaySeq: r.replaySeq,
    })));
    const projected = [...replayed.balances.entries()].map(([owner, amount]) => ({ owner, amount: amount.toString() }));
    return {
      pid,
      rows: rows.map((r) => ({
        replaySeq: r.replaySeq?.toString() ?? null, kind: r.kind, providerRef: r.providerRef,
        providerStatus: r.providerStatus, amountIdr: r.amountIdr.toString(),
        direction: r.direction, sourceAccount: r.sourceAccount, destAccount: r.destAccount,
        entryGroup: r.entryGroup, ledgerRef: r.ledgerRef, ledgerStatus: r.ledgerStatus,
        settlementStatus: r.settlementStatus, extinguished: r.extinguished,
        counterparty: r.counterparty, createdAt: r.createdAt,
      })),
      replay: {
        projected, treasury: replayed.treasury.toString(),
        inFlight: replayed.inFlight, skippedFiat: replayed.skippedFiat, errors: replayed.errors,
      },
    };
  }

  /**
   * Admin: platform-wide replay projection — answers "which users own the
   * outstanding claim" across all swept rows. Bounded (recent 5000 rows);
   * full-fidelity answers come from per-PID journal exports + sweep.
   */
  async adminReplay() {
    const rows = await this.prisma.fiatProviderTransaction.findMany({
      orderBy: { replaySeq: "desc" }, take: 5000,
    });
    const replayed = replayJournal(rows.map((r) => ({
      kind: r.kind, pid: r.pid, providerRef: r.providerRef, providerStatus: r.providerStatus,
      amountIdr: r.amountIdr, direction: r.direction, entryGroup: r.entryGroup,
      extinguished: r.extinguished, counterparty: (r.counterparty ?? null) as Record<string, unknown> | null,
      replaySeq: r.replaySeq,
    })));
    return {
      owners: [...replayed.balances.entries()].map(([owner, amount]) => ({ owner, amount: amount.toString() })),
      treasury: replayed.treasury.toString(),
      inFlight: replayed.inFlight.length, skippedFiat: replayed.skippedFiat,
      errors: replayed.errors,
      note: "bounded to the 5000 most recent rows — per-PID journal exports are authoritative",
    };
  }

  // --- reconciliation + drift (DOKU authoritative, local rows are hints) ---

  /**
   * Reconcile one PID over a window: DOKU history (IDR + Pending + POINT
   * accounts) vs local journal matched on partnerReferenceNo.
   * - Backfills missed inbound CREDIT+SUCCESS fiat rows as deposits, then
   *   completes their point issuance (same idempotent path as webhooks).
   * - Completes issuance for settled deposits with outstanding legs.
   * - Marks fiat settlementStatus when SETTLEMENT-family rows appear
   *   (backing event — never a user credit).
   * - Reports the backing gap: outstanding points vs fiat backing, with
   *   observed PG fees so ops can tell routine channel costs from real drift.
   * Unparseable rows are counted, never assumed. Pages capped, truncation
   * flagged. Never synthesizes money, never double-issues (refs are unique).
   */
  async reconcile(pid: string, q: { fromDateTime: string; toDateTime: string }) {
    const account = await this.requireActive(pid);
    const accountNos = this.ownedAccountNos(account);
    if (accountNos.length === 0) throw new ServiceUnavailableException("Sub-account numbers unknown");
    const local = await this.prisma.fiatProviderTransaction.findMany({ where: { pid }, take: 5000 });
    const byRef = new Map(local.map((r) => [r.providerRef, r]));
    const seen = new Set<string>();
    let backfilled = 0;
    let unparseable = 0;
    let truncated = false;
    let pgObserved = 0n;
    let issued = 0;
    const settledFiatRefs = new Set<string>();
    const policy = await this.activeFeePolicy().catch(() => null);
    for (const accountNo of accountNos) {
      for (let page = 0; page < 5; page++) {
        let items;
        try {
          const res = await this.sac.history({ accountNo, fromDateTime: q.fromDateTime, toDateTime: q.toDateTime, pageSize: "100", pageNumber: String(page) });
          items = res.items;
        } catch (err) {
          throw this.mapError(err, "reconciliation history");
        }
        for (const it of items) {
          const ref = it.partnerReferenceNo;
          if (!ref) {
            unparseable++;
            continue;
          }
          seen.add(ref);
          // PG channel costs explain part of the backing gap — track them.
          if (it.transactionType === "SETTLEMENT_FEE" && it.status === "SUCCESS" && it.amountIdr !== undefined) {
            try {
              pgObserved += parseIdrStrict(it.amountIdr, "pg amount");
            } catch { /* counted below as unparseable only when money moves */ }
          }
          const row = byRef.get(ref);
          if (row) {
            if (["created", "processing"].includes(row.providerStatus)) {
              const rowCp = (row.counterparty ?? {}) as Record<string, any>;
              // Checkout rail: payment confirmation via order status — txStatus
              // codes track settlement here and must never gate issuance.
              if (row.kind === "deposit" && this.isCheckoutRow(rowCp)) {
                try {
                  const corr = await this.withRetry(() => this.corroborateCheckoutPayment(ref), "reconcile order status");
                  if (corr.outcome === "paid") {
                    if (await this.assertInvoiceAmountMatch(row.id, row.amountIdr, corr.paidAmount, ref)) {
                      await this.markPayment(row.id, "success", corr.raw);
                      await this.issuePointsForDeposit(row.id, "reconcile");
                      await this.ledger.issueForDeposit(row.id, "reconcile");
                      issued++;
                    }
                  } else if (corr.outcome === "expired") {
                    await this.markPayment(row.id, "expired", { checkoutExpired: true });
                  } else if (corr.outcome === "failed") {
                    await this.markPayment(row.id, "failed", { checkoutFailed: true });
                    if (["issued", "partial"].includes(row.ledgerStatus ?? "")) {
                      await this.proposeClawback(row.providerRef, "checkout failed after issuance (reconcile)", "failed", corr.paidAmount).catch(() => undefined);
                    }
                  }
                } catch (err) {
                  this.logger.warn(`reconcile status failed for ${ref}: ${String(err)?.slice(0, 200)}`);
                }
              } else {
                try {
                  const st = await this.withRetry(() => this.sac.txStatus(ref), "reconcile status");
                  const status = mapSacStatus(st.latestTransactionStatus);
                  if (row.kind === "deposit") {
                    await this.markPayment(row.id, this.mapSacToPayment(status), st.rawResponse);
                  } else {
                    await this.markTx(row.id, status, st.rawResponse);
                  }
                  if ((status === "failed" || status === "refunded") && row.kind === "deposit" && ["issued", "partial"].includes(row.ledgerStatus ?? "")) {
                    await this.proposeClawback(
                      row.providerRef, `provider ${status} after issuance (reconcile)`, status,
                      this.corroboratedAmount((st.amount as { value?: unknown } | undefined)?.value),
                    ).catch(() => undefined);
                  }
                  if (status === "settled" && row.kind === "deposit") {
                    await this.issuePointsForDeposit(row.id, "reconcile");
              await this.ledger.issueForDeposit(row.id, "reconcile");
                    issued++;
                  }
                } catch (err) {
                  this.logger.warn(`reconcile status failed for ${ref}: ${String(err)?.slice(0, 200)}`);
                }
              }
            } else if (row.kind === "deposit" && (row.ledgerStatus ?? "") !== "issued") {
              await this.issuePointsForDeposit(row.id, "reconcile");
              await this.ledger.issueForDeposit(row.id, "reconcile");
              issued++;
            }
            // Fiat settlement legs are backing events, never user credits.
            if (row.kind === "deposit" && (row.settlementStatus ?? "") !== "settled" &&
              ["SETTLEMENT", "SPLIT_TRANSACTION", "SETTLEMENT_FEE"].includes(it.transactionType ?? "") &&
              it.status === "SUCCESS") {
              settledFiatRefs.add(row.id);
            }
            continue;
          }
          // Unknown DOKU row: backfill inbound CREDIT+SUCCESS as deposits.
          // Payment state is UNKNOWN here (settlement history proves backing,
          // never payment) — write "processing" and corroborate below. Never
          // write "settled": that vocabulary now means payment-confirmed.
          if (it.mutationType === "CREDIT" && it.status === "SUCCESS" && it.amountIdr !== undefined) {
            try {
              const gross = parseIdrStrict(it.amountIdr, "reconcile amount");
              const flagged = policy ? gross - calcServiceFee(gross, policy) < MIN_CHECKOUT_NET_IDR : false;
              const bf = await this.prisma.fiatProviderTransaction.upsert({
                where: { providerRef: ref },
                create: {
                  pid, accountId: accountNo, kind: "deposit", providerRef: ref, amountIdr: gross,
                  // CREDIT history is payment-ish, never settlement evidence —
                  // settlement stays pending until a SETTLEMENT-family row lands.
                  providerStatus: "processing", ledgerStatus: "pending", settlementStatus: "pending",
                  counterparty: {
                    source: "reconcile", channel: it.channel ?? null, transactionType: it.transactionType ?? null,
                    ...(flagged ? { belowMinimumNet: true } : {}),
                  },
                  providerResponse: json(it),
                },
                update: {},
              });
              backfilled++;
              // Corroborate before any issuance: our invoice → order status;
              // anything else → VA path (txStatus). Unknown refs stay pending.
              try {
                const corr = await this.withRetry(() => this.corroborateCheckoutPayment(ref), "backfill order status");
                if (corr.outcome === "paid" && await this.assertInvoiceAmountMatch(bf.id, gross, corr.paidAmount, ref)) {
                  await this.markPayment(bf.id, "success", corr.raw);
                  await this.issuePointsForDeposit(bf.id, "reconcile");
                  await this.ledger.issueForDeposit(bf.id, "reconcile");
                  issued++;
                }
              } catch {
                // Not our invoice (or order API unavailable) → VA/unknown path:
                // txStatus corroboration, same as the matched-row branch. On
                // corroborated success the row is dual-written (payment
                // success + legacy settled); issuance additionally requires
                // the VA kill-switch (PROVIDER-DEP-01) — txStatus-00-alone
                // semantics for VA remain sandbox-verify, never inferred.
                try {
                  const st = await this.withRetry(() => this.sac.txStatus(ref), "backfill status");
                  if (mapSacStatus(st.latestTransactionStatus) === "settled") {
                    await this.markPayment(bf.id, "success", st.rawResponse);
                    await this.issuePointsForDeposit(bf.id, "reconcile");
                  await this.ledger.issueForDeposit(bf.id, "reconcile");
                    issued++;
                  }
                } catch (err) {
                  this.logger.warn(`backfill corroboration failed for ${ref}: ${String(err)?.slice(0, 200)}`);
                }
              }
            } catch {
              unparseable++;
            }
          } else if (it.amountIdr === undefined && (it.mutationType === "CREDIT" || it.mutationType === "DEBIT")) {
            unparseable++;
          }
        }
        if (items.length < 100) break;
        if (page === 4) truncated = true;
      }
    }
    if (settledFiatRefs.size > 0) {
      await this.prisma.fiatProviderTransaction.updateMany({
        where: { id: { in: [...settledFiatRefs] } },
        data: { settlementStatus: "settled" },
      }).catch(() => undefined);
    }
    const missingProvider = local.filter((r) => ["created", "processing"].includes(r.providerStatus) && !seen.has(r.providerRef)).map((r) => r.providerRef);
    // Deposits paid but still missing issued points need attention.
    const pendingIssuance = local
      .filter((r) => r.kind === "deposit" && ["settled", "success"].includes(r.providerStatus) && (r.ledgerStatus ?? "") !== "issued")
      .map((r) => r.providerRef);
    const backing = await this.backingReport(pid).catch(() => null);
    const drift = await this.driftCheck(pid);
    return {
      matched: seen.size, backfilled, unparseable, truncated, missingProvider,
      issued, pendingIssuance, pgObservedIdr: pgObserved.toString(), backing, drift,
    };
  }

  /**
   * Backing report, replay-based.
   * Invariant 1 (EXACT, alerts): replay(journal) for this PID must equal the
   * live DOKU POINT balance. Any mismatch or replay error is a P0 alert.
   * Per-PID fiat gap is INFORMATION ONLY: after P2P transfers fiat stays
   * where it landed while liability moves, so per-user PTS↔fiat equality is
   * invalid by construction. Aggregate backing is checked in adminSweep.
   */
  private async backingReport(pid: string) {
    const account = await this.requireActive(pid);
    if (!account.profileId) throw new ServiceUnavailableException("Sub-account not registered");
    const bal = await this.withRetry(() => this.sac.balance(account.profileId as string), "backing balance");
    const num = (type: string, field: "available" | "reserved"): bigint => {
      const a = bal.accounts.find((x) => x.type === type);
      try {
        return parseIdrStrict(field === "available" ? (a?.available ?? "0") : (a?.reserved ?? "0"), "backing");
      } catch {
        return 0n;
      }
    };
    const livePoints = num(POINT_ACCOUNT, "available") + num(POINT_ACCOUNT, "reserved");
    const fiatBacking = num(IDR_ACCOUNT, "available") + num(IDR_ACCOUNT, "reserved") + num(PENDING_ACCOUNT, "available");
    const rows = await this.prisma.fiatProviderTransaction.findMany({
      where: { pid }, take: 5000, orderBy: { replaySeq: "asc" },
    });
    const replayed = replayJournal(rows.map((r) => ({
      kind: r.kind, pid: r.pid, providerRef: r.providerRef, providerStatus: r.providerStatus,
      amountIdr: r.amountIdr, direction: r.direction, entryGroup: r.entryGroup,
      extinguished: r.extinguished, counterparty: (r.counterparty ?? null) as Record<string, unknown> | null,
      replaySeq: r.replaySeq,
    })));
    const replayedPid = replayed.balances.get(pid) ?? 0n;
    const alerts: string[] = [];
    if (replayedPid !== livePoints) {
      alerts.push(`INVARIANT-1 journal replay ${replayedPid} != live DOKU ${livePoints}`);
    }
    for (const e of replayed.errors) alerts.push(`INVARIANT-1 replay error: ${e}`);
    for (const a of alerts) this.logger.warn(`backing ${pid}: ${a}`);
    return {
      livePointsIdr: livePoints.toString(), replayedIdr: replayedPid.toString(),
      treasuryCreditedIdr: replayed.treasury.toString(),
      fiatBackingIdr: fiatBacking.toString(), gapIdr: (livePoints - fiatBacking).toString(),
      gapNote: "info-only: fiat stays where it landed while PTS liability moves via P2P",
      inFlight: replayed.inFlight, alerts,
    };
  }

  /**
   * Invariant-2 enforcement (binding — see docs/prds/PRD_v6.md §3):
   * gap = outstanding − backing − adjustments must be zero after rounding.
   * The ONLY allowance is documented per-leg rounding: Rp1 per settled
   * points leg. No percentage tolerance exists anywhere — a percentage would
   * scale permitted error with volume and mask real breaks. PG fees enter
   * exclusively as observed SETTLEMENT_FEE rows; reserves enter exclusively
   * via PID_REDEMPTION_RESERVE_IDR. Anything else unexplained → ALERT + halt.
   */
  private async pgObservedForIdrAccount(accountNo: string, fromDate: string, toDate: string): Promise<bigint> {
    let total = 0n;
    for (let page = 0; page < 2; page++) {
      let items;
      try {
        const res = await this.sac.history({ accountNo, fromDateTime: fromDate, toDateTime: toDate, pageSize: "100", pageNumber: String(page) });
        items = res.items;
      } catch (err) {
        this.logger.warn(`sweep PG scan failed for ${accountNo}: ${String(err)?.slice(0, 160)}`);
        break;
      }
      for (const it of items) {
        if (it.transactionType === "SETTLEMENT_FEE" && it.status === "SUCCESS" && it.amountIdr !== undefined) {
          try {
            total += parseIdrStrict(it.amountIdr, "pg amount");
          } catch { /* unparseable PG row: counted as unexplained via gap, never assumed */ }
        }
      }
      if (items.length < 100) break;
    }
    return total;
  }

  private redemptionReserveIdr(): bigint {
    const raw = this.config.get<string>("PID_REDEMPTION_RESERVE_IDR", "0") || "0";
    try {
      return parseIdrStrict(raw, "reserve");
    } catch {
      this.logger.warn(`PID_REDEMPTION_RESERVE_IDR unparseable (${raw}) — treated as 0`);
      return 0n;
    }
  }

  /**
   * Admin sweep (cron-driven): per active account, complete outstanding
   * deposit issuance AND transfer legs/mirrors, then report backing.
   * Rolls up the platform aggregate (invariant 2) across swept accounts:
   * total replayed outstanding (incl. Treasury) vs total fiat backing.
   * Bounded and resumable via skip/take. Never throws per-PID.
   */
  async adminSweep(input: { take?: number; skip?: number }) {
    const take = Math.min(Math.max(input.take ?? 20, 1), 100);
    const skip = Math.max(input.skip ?? 0, 0);
    const total = await this.prisma.fiatProviderAccount.count({ where: { provider: PROVIDER, accountStatus: "active" } });
    const accounts = await this.prisma.fiatProviderAccount.findMany({
      where: { provider: PROVIDER, accountStatus: "active" },
      orderBy: { createdAt: "asc" }, take, skip,
      select: { pid: true },
    });
    const results: Array<Record<string, unknown>> = [];
    let aggLive = 0n;
    let aggReplayed = 0n;
    let aggTreasury = 0n;
    let aggFiat = 0n;
    for (const a of accounts) {
      try {
        const settled = await this.prisma.fiatProviderTransaction.findMany({
          where: { pid: a.pid, kind: "deposit", providerStatus: { in: ["settled", "success"] } },
          orderBy: { createdAt: "asc" }, take: 100,
        });
        let completed = 0;
        for (const r of settled) {
          if ((r.ledgerStatus ?? "") === "issued") continue;
          await this.issuePointsForDeposit(r.id, "sweep");
          await this.ledger.issueForDeposit(r.id, "sweep");
          completed++;
        }
        // Complete transfer legs + mirrors for settled/processing transfers.
        const transfers = await this.prisma.fiatProviderTransaction.findMany({
          where: { pid: a.pid, kind: "transfer_internal", providerStatus: { in: ["processing", "settled"] } },
          orderBy: { createdAt: "asc" }, take: 50,
        });
        for (const t of transfers) {
          const feeRef = `${t.providerRef}-PTFEE`;
          const feeLeg = await this.prisma.fiatProviderTransaction.findFirst({
            where: { kind: "points_fee", providerRef: feeRef },
          }).catch(() => null);
          if (!feeLeg || !["settled", "processing"].includes(feeLeg.providerStatus)) {
            const cp = (t.counterparty ?? {}) as Record<string, any>;
            const fee = typeof cp.feeQuote === "string" && /^\d+$/.test(cp.feeQuote) ? BigInt(cp.feeQuote) : 0n;
            if (fee > 0n) {
              const fromPoint = await this.pointAccountFor(a.pid, "Sender").catch(() => undefined);
              if (fromPoint) {
                await this.executePointFeeLeg(a.pid, fromPoint, feeRef, fee, t.providerRef).catch((err) => {
                  this.logger.warn(`sweep fee leg failed for ${t.providerRef}: ${String(err)?.slice(0, 200)}`);
                });
                completed++;
              }
            }
          }
          // Corroborate open transfer legs (parent + mirror) — replay only
          // counts settled rows, so processing legs must converge here.
          if (t.providerStatus === "processing") {
            try {
              const st = await this.withRetry(() => this.sac.txStatus(t.providerRef), "sweep transfer status");
              const status = mapSacStatus(st.latestTransactionStatus);
              if (status !== "processing") {
                await this.markTx(t.id, status, st.rawResponse);
                const mirror = await this.prisma.fiatProviderTransaction.findFirst({
                  where: { kind: "points_credit", counterparty: { path: ["parentRef"], equals: t.providerRef } },
                }).catch(() => null);
                if (mirror && status === "settled") {
                  await this.markTx(mirror.id, "settled", st.rawResponse);
                  await this.prisma.fiatProviderTransaction.update({
                    where: { id: mirror.id }, data: { ledgerStatus: "issued" },
                  }).catch(() => undefined);
                }
                completed++;
              }
            } catch (err) {
              this.logger.warn(`sweep transfer status failed for ${t.providerRef}: ${String(err)?.slice(0, 160)}`);
            }
          }
          const mirrorOutcome = await this.ensureTransferMirror(t as never).catch(() => "review" as const);
          if (mirrorOutcome === "mirrored") completed++;
        }
        const backing = await this.backingReport(a.pid);
        aggLive += BigInt(backing.livePointsIdr);
        aggReplayed += BigInt(backing.replayedIdr);
        aggTreasury += BigInt(backing.treasuryCreditedIdr);
        aggFiat += BigInt(backing.fiatBackingIdr);
        results.push({ pid: a.pid, checked: settled.length, transfers: transfers.length, completed, backing });
      } catch (err) {
        results.push({ pid: a.pid, error: String(err instanceof Error ? err.message : err).slice(0, 200) });
      }
    }
    // Treasury's own live POINT balance (fee revenue pool, redeemable).
    // Resolved via DOKU_TREASURY_PROFILE_ID when set; otherwise projected
    // from settled fee legs (flagged as projection in the report).
    let treasuryLive = "0";
    let treasuryLiveSource = "projection";
    try {
      const treasuryProfile = this.config.get<string>("DOKU_TREASURY_PROFILE_ID", "");
      if (treasuryProfile) {
        const tb = await this.withRetry(() => this.sac.balance(treasuryProfile), "treasury sweep balance");
        const tp = tb.accounts.find((x) => x.type === POINT_ACCOUNT);
        if (tp) {
          try {
            treasuryLive = (parseIdrStrict(tp.available ?? "0", "treasury") + parseIdrStrict(tp.reserved ?? "0", "treasury")).toString();
            treasuryLiveSource = "live";
          } catch { /* keep projection fallback below */ }
        }
      }
      if (treasuryLiveSource !== "live") {
        treasuryLive = await this.treasuryLiveFromHistory();
      }
    } catch (err) {
      this.logger.warn(`sweep treasury balance failed: ${String(err)?.slice(0, 200)}`);
    }
    const outstanding = aggReplayed + aggTreasury;
    const gap = outstanding - aggFiat;
    // Explicit adjustments ledger — every row cited, nothing netted silently:
    // PG fees observed as SETTLEMENT_FEE history rows on swept IDR accounts,
    // plus the configured platform reserve. Rounding allowance is Rp1 per
    // settled points leg (representation drift bound, not error budget).
    const toDate = new Date().toISOString().slice(0, 10);
    const fromDate = new Date(Date.now() - 30 * 24 * 3600_000).toISOString().slice(0, 10);
    let pgObserved = 0n;
    const pgPerAccount: Array<{ accountNo: string; pgIdr: string }> = [];
    for (const a of accounts) {
      const row = await this.prisma.fiatProviderAccount.findUnique({
        where: { pid_provider: { pid: a.pid, provider: PROVIDER } },
      }).catch(() => null);
      const idrNo = row?.providerAccountId ?? undefined;
      if (!idrNo) continue;
      const pg = await this.pgObservedForIdrAccount(idrNo, fromDate, toDate);
      if (pg > 0n) pgPerAccount.push({ accountNo: idrNo, pgIdr: pg.toString() });
      pgObserved += pg;
    }
    const reserve = this.redemptionReserveIdr();
    const settledLegs = await this.prisma.fiatProviderTransaction.count({
      where: {
        pid: { in: accounts.map((a) => a.pid) },
        kind: { in: ["points_issue", "points_fee", "points_credit", "points_clawback", "points_redeem"] },
        providerStatus: "settled",
      },
    }).catch(() => 0);
    const roundingAllowance = BigInt(settledLegs);
    const adjustments = [
      { kind: "pg_observed_settlement_fees", amountIdr: pgObserved.toString(), window: `${fromDate}..${toDate}`, perAccount: pgPerAccount },
      { kind: "platform_reserve", amountIdr: reserve.toString(), source: "PID_REDEMPTION_RESERVE_IDR" },
      { kind: "rounding_allowance", amountIdr: roundingAllowance.toString(), formula: "Rp1 x settled points legs", legs: settledLegs },
    ];
    const unexplained = gap - pgObserved - reserve;
    const explained = unexplained < 0n ? -unexplained <= roundingAllowance : unexplained <= roundingAllowance;
    const aggregate = {
      sweptPids: accounts.length,
      livePointsIdr: (aggLive + BigInt(treasuryLive)).toString(),
      replayedOutstandingIdr: outstanding.toString(),
      treasuryLiveIdr: treasuryLive,
      treasuryLiveSource,
      fiatBackingIdr: aggFiat.toString(),
      gapIdr: gap.toString(),
      adjustments,
      unexplainedIdr: unexplained.toString(),
      verdict: explained
        ? "ok: every nonzero difference maps to an explicit adjustment row"
        : "ALERT: unexplained backing difference — redemption halted, investigate",
    };
    if (!explained) {
      this.logger.error(`sweep aggregate ${aggregate.verdict}: unexplained ${unexplained}`);
      this.setRedemptionHalt(true, `aggregate unexplained gap ${unexplained}`);
    }
    const recovery = this.redemptionEnabled() ? await this.recoverRedemptions().catch(() => ({ resumed: 0, expired: 0 })) : { resumed: 0, expired: 0, disabled: true };
    return { total, swept: results.length, skip, take, results, aggregate, recovery, redemptionHalted: this.redemptionHalted };
  }

  /** Fallback Treasury-live estimate when no Treasury profile is configured:
   *  sums settled points_fee legs from the journal (projection, flagged). */
  private async treasuryLiveFromHistory(): Promise<string> {
    const legs = await this.prisma.fiatProviderTransaction.findMany({
      where: { kind: "points_fee", providerStatus: "settled" },
      select: { amountIdr: true }, take: 5000,
    });
    return legs.reduce((s, r) => s + r.amountIdr, 0n).toString();
  }

  /**
   * Admin backfill: issue makeup points for settled deposits that predate
   * the ledger (or missed every other path). Existing fiat is untouched —
   * this only credits what the journal says is owed. Every leg is stamped
   * `source: backfill` for ops review.
   */
  async adminBackfill(input: { pid?: string; take?: number }) {
    const take = Math.min(Math.max(input.take ?? 100, 1), 500);
    const rows = await this.prisma.fiatProviderTransaction.findMany({
      where: { kind: "deposit", providerStatus: { in: ["settled", "success"] }, ...(input.pid ? { pid: input.pid } : {}) },
      orderBy: { createdAt: "asc" }, take: take * 2,
    });
    const todo = rows.filter((r) => (r.ledgerStatus ?? "") !== "issued").slice(0, take);
    for (const r of todo) {
      await this.prisma.fiatProviderTransaction.update({
        where: { id: r.id },
        data: { counterparty: json({ ...((r.counterparty ?? {}) as Record<string, unknown>), source: "backfill" }) },
      }).catch(() => undefined);
      await this.issuePointsForDeposit(r.id, "backfill");
      await this.ledger.issueForDeposit(r.id, "backfill");
    }
    const done = await this.prisma.fiatProviderTransaction.findMany({
      where: { id: { in: todo.map((r) => r.id) } },
      select: { providerRef: true, ledgerStatus: true },
    });
    return {
      processed: todo.length,
      issued: done.filter((r) => r.ledgerStatus === "issued").length,
      outstanding: done.filter((r) => r.ledgerStatus !== "issued").map((r) => ({ providerRef: r.providerRef, ledgerStatus: r.ledgerStatus })),
    };
  }

  /**
   * Drift check: live DOKU balance vs our timestamped cache. Any difference
   * means the cache is stale (expected) or rows were missed (investigate via
   * reconcile) — either way the live value wins and the cache refreshes.
   */
  async driftCheck(pid: string) {
    const account = await this.requireActive(pid);
    if (!account.profileId) throw new ServiceUnavailableException("Sub-account not registered");
    const cached = account.lastBalance;
    let live: string;
    try {
      const res = await this.withRetry(() => this.sac.balance(account.profileId as string), "drift balance");
      const idr = res.accounts.find((a) => a.type === IDR_ACCOUNT);
      live = parseIdrStrict(idr?.available ?? "0", "drift balance").toString();
      await this.prisma.fiatProviderAccount
        .update({ where: { id: account.id }, data: { lastBalance: live, lastBalanceAt: new Date(), accounts: json(res.accounts) } })
        .catch(() => undefined);
    } catch (err) {
      throw this.mapError(err, "drift check");
    }
    return { liveIdr: live, cachedIdr: cached, drift: cached !== null && cached !== live, checkedAt: new Date() };
  }

  // --- webhook inbox (persist-first; DOKU query corroborates) ---

  /**
   * Notifications have no published signing contract, so a webhook is a
   * HINT: persist it (dedup on X-EXTERNAL-ID), then corroborate against
   * DOKU before applying any state change. Forged/unknown events stay
   * `received` for admin review. Checkout notifies carry the invoice number
   * as partnerReferenceNo and are corroborated the same way.
   */
  async webhook(externalId: string | undefined, rawBody: string): Promise<{ ok: boolean }> {
    if (!externalId) return { ok: false };
    let body: Record<string, any>;
    try {
      body = JSON.parse(rawBody) as Record<string, any>;
    } catch {
      return { ok: false };
    }
    const providerRef: string | undefined =
      body?.partnerReferenceNo ?? body?.originalPartnerReferenceNo ?? body?.trxId ?? body?.order?.invoice_number;
    try {
      await this.prisma.fiatWebhookEvent.create({
        data: { provider: PROVIDER, externalId, eventType: String(body?.eventType ?? body?.transactionType ?? "notification"), payload: json(body) },
      });
    } catch {
      return { ok: true }; // duplicate X-EXTERNAL-ID = idempotent replay
    }
    // Register notification: refresh the cached accounts/VA for the profile.
    const profileId: string | undefined = body?.profileId ? String(body.profileId) : undefined;
    if (!providerRef && profileId) {
      const account = await this.prisma.fiatProviderAccount.findUnique({ where: { profileId } }).catch(() => null);
      if (account) {
        try {
          const bal = await this.withRetry(() => this.sac.balance(profileId), "register webhook balance");
          await this.prisma.fiatProviderAccount.update({
            where: { id: account.id },
            data: { accounts: json(bal.accounts), accountStatus: "active", providerResponse: json(bal.rawResponse) },
          });
        } catch (err) {
          this.logger.warn(`register webhook corroboration failed: ${String(err)?.slice(0, 200)}`);
          return { ok: true };
        }
      }
      await this.prisma.fiatWebhookEvent.update({ where: { externalId }, data: { status: "applied" } }).catch(() => undefined);
      return { ok: true };
    }
    if (!providerRef) return { ok: true }; // uncorrelatable — stays received
    const row = await this.prisma.fiatProviderTransaction.findUnique({ where: { providerRef: String(providerRef) } }).catch(() => null);
    if (!row) {
      // Inbound money (BRI VA / Checkout / Direct) references no Peridot row:
      // record it as a deposit when it names one of our accounts.
      const recorded = await this.recordInboundDeposit(String(providerRef), body).catch(() => false);
      if (recorded) {
        await this.prisma.fiatWebhookEvent.update({ where: { externalId }, data: { status: "applied" } }).catch(() => undefined);
      }
      return { ok: true }; // unrecorded stays received for admin review
    }
    if (!["created", "processing"].includes(row.providerStatus)) {
      // Already terminal — but a reversal signal for an ISSUED deposit must
      // still be heard: inspect the notify-declared status (cheap, untrusted)
      // and corroborate before proposing anything. Anything else → no-op.
      // Both notify shapes are heard: Checkout documented fields
      // (order.invoice_number + transaction.status) and the VA shape
      // (partnerReferenceNo + transaction.status).
      if (row.kind === "deposit" && ["issued", "partial"].includes(row.ledgerStatus ?? "")) {
        const txStatusRaw = (body?.transaction as Record<string, unknown> | undefined)?.status;
        const declared = parseCheckoutNotify(body)?.txStatus
          ?? (typeof txStatusRaw === "string" ? txStatusRaw : undefined);
        if (declared && ["FAILED", "REFUNDED", "EXPIRED"].includes(declared)) {
          const cp = (row.counterparty ?? {}) as Record<string, any>;
          if (this.isCheckoutRow(cp)) {
            try {
              const corr = await this.withRetry(() => this.corroborateCheckoutPayment(String(providerRef)), "reversal corroboration");
              if (corr.outcome === "failed" || corr.outcome === "expired") {
                await this.proposeClawback(row.providerRef, `checkout ${corr.outcome} after issuance`, String(corr.outcome), corr.paidAmount).catch(() => undefined);
              }
            } catch {
              // Corroboration failed — leave for sweep/poll, never invent.
            }
          } else {
            try {
              const detail = await this.withRetry(() => this.sac.txStatus(String(providerRef)), "reversal corroboration");
              const status = mapSacStatus(detail.latestTransactionStatus);
              if (status === "failed" || status === "refunded") {
                await this.proposeClawback(
                  row.providerRef, `provider ${status} after issuance`, status,
                  this.corroboratedAmount((detail.amount as { value?: unknown } | undefined)?.value),
                ).catch(() => undefined);
              }
            } catch {
              // Corroboration failed — leave for sweep/poll, never invent.
            }
          }
        }
      }
      await this.prisma.fiatWebhookEvent.update({ where: { externalId }, data: { status: "applied" } }).catch(() => undefined);
      return { ok: true };
    }
    // Checkout notifies carry the invoice number as partnerReferenceNo and
    // are corroborated through the order status API below (never trusted).
    try {
      const cp = (row.counterparty ?? {}) as Record<string, any>;
      // Checkout rail: corroborate through the order status, never through
      // Sub-Account settlement state.
      if (row.kind === "deposit" && this.isCheckoutRow(cp)) {
        let corr: { outcome: string; paidAmount: bigint | null; raw: unknown };
        try {
          corr = await this.withRetry(() => this.corroborateCheckoutPayment(String(providerRef)), "webhook order status");
        } catch (err) {
          this.logger.warn(`webhook corroboration failed for ${providerRef}: ${String(err)?.slice(0, 200)}`);
          return { ok: true };
        }
        // Reversal after issuance never auto-claws-back: propose a
        // reviewable candidate instead (correction: no unconditional auto).
        // Partial/ambiguous reversals stay blocked (no candidate) — the
        // corroborated amount is passed so proposeClawback can enforce it.
        if ((corr.outcome === "failed" || corr.outcome === "expired") && ["issued", "partial"].includes(row.ledgerStatus ?? "")) {
          await this.proposeClawback(row.providerRef, `checkout ${corr.outcome} after issuance`, String(corr.outcome), corr.paidAmount).catch(() => undefined);
        }
        if (corr.outcome === "paid") {
          await this.markPayment(row.id, "success", corr.raw);
          // Paid deposits unlock the Saldo: issue Unified Ledger points via
          // the idempotent backend-only path (fire-and-forget — ack fast;
          // the sweep completes anything missed). Never on caller claims —
          // corroborated above, re-verified inside.
          void this.issuePointsForDeposit(row.id, "webhook");
          void this.ledger.issueForDeposit(row.id, "webhook");
        } else if (corr.outcome === "expired") {
          await this.markPayment(row.id, "expired", { checkoutExpired: true });
        } else if (corr.outcome === "failed") {
          await this.markPayment(row.id, "failed", { checkoutFailed: true });
        }
        // pending/unknown: leave the row untouched for a later push or poll.
      } else {
        const detail = await this.withRetry(() => this.sac.txStatus(String(providerRef)), "webhook status");
        const status = mapSacStatus(detail.latestTransactionStatus);
        // Deposits dual-write payment truth (provisional VA semantics);
        // transfer legs keep movement state only. Settlement rows never
        // confirm payment for Checkout rows — this branch is non-Checkout.
        if (row.kind === "deposit") {
          await this.markPayment(row.id, this.mapSacToPayment(status), detail.rawResponse);
        } else {
          await this.markTx(row.id, status, detail.rawResponse);
        }
        // Reversal after issuance → reviewable candidate, never auto-clawback.
        if ((status === "failed" || status === "refunded") && row.kind === "deposit" && ["issued", "partial"].includes(row.ledgerStatus ?? "")) {
          await this.proposeClawback(
            row.providerRef, `provider ${status} after issuance`, status,
            this.corroboratedAmount((detail.amount as { value?: unknown } | undefined)?.value),
          ).catch(() => undefined);
        }
        if (status === "settled" && row.kind === "deposit") {
          void this.issuePointsForDeposit(row.id, "webhook");
          void this.ledger.issueForDeposit(row.id, "webhook");
        }
      }
    } catch (err) {
      this.logger.warn(`webhook corroboration failed for ${providerRef}: ${String(err)?.slice(0, 200)}`);
      return { ok: true };
    }
    await this.prisma.fiatWebhookEvent.update({ where: { externalId }, data: { status: "applied" } }).catch(() => undefined);
    await this.security.log(row.pid, "fiat.subaccount.webhook_applied", { providerRef }).catch(() => undefined);
    return { ok: true };
  }

  // --- internals ---

  /**
   * Persist an inbound deposit observed via webhook. Matches ANY of the
   * sub-account's numbers (IDR + Pending + VA rail); amounts parse strictly.
   * Funds are always preserved (never rejected). Inbound VA credits are NOT
   * Checkout top-ups: when the derived net (received − fee) falls below the
   * Rp100.000 Checkout minimum, the row is flagged
   * (counterparty.belowMinimumNet) for separate exception handling instead
   * of being silently treated as a valid top-up.
   *
   * The notify body is an UNSIGNED hint (correction §3): it is persisted,
   * then corroborated through the documented status APIs before ANY state
   * becomes payment truth. Checkout-shaped bodies (order.invoice_number)
   * are tagged channel=checkout and corroborated via order status ONLY —
   * txStatus codes track settlement for that rail and must never confirm
   * payment. VA-shaped bodies use txStatus. Declared statuses alone never
   * write terminal payment state (a forged FAILED must not brick a deposit).
   */
  private async recordInboundDeposit(providerRef: string, body: Record<string, any>): Promise<boolean> {
    const toAccount: string | undefined =
      body?.toAccount ? String(body.toAccount)
      : body?.beneficiaryAccountNumber ? String(body.beneficiaryAccountNumber)
      : body?.virtualAccountNo ? String(body.virtualAccountNo)
      : body?.accountNo ? String(body.accountNo)
      : undefined;
    const amountRaw = body?.amount?.value ?? body?.paidAmount?.value ?? body?.amount;
    if (!toAccount || amountRaw == null) return false;
    const account = await this.prisma.fiatProviderAccount.findFirst({ where: { providerAccountId: toAccount } });
    const owned = account ?? (await this.findAccountByAnyNumber(toAccount));
    if (!owned) return false;
    let gross: bigint;
    try {
      gross = parseIdrStrict(amountRaw, "webhook amount");
    } catch {
      return false; // unparseable — stays received for admin review
    }
    if (gross <= 0n) return false;
    // VA payment-confirmation signal (provisional, PROVIDER-DEP-01): a
    // persisted SUCCESS notify is REQUIRED for VA issuance, and txStatus
    // corroboration below is defense-in-depth. Whether txStatus "00" alone
    // means payment-received vs settlement-only for VA is UNCONFIRMED —
    // sandbox-verify before treating it as sufficient on its own. An absent
    // status field leaves the row processing: issuance then relies on the
    // same corroboration (never on inference).
    const notifyTx = (body?.transaction as Record<string, unknown> | undefined)?.status;
    const notifyTxStatus = typeof notifyTx === "string" ? notifyTx : undefined;
    // Checkout-shaped notify (documented fields only): this ref is a Checkout
    // invoice, so the row takes the Checkout rail — order-status
    // corroboration only, never txStatus.
    const checkoutShaped = parseCheckoutNotify(body) != null;
    const policy = await this.activeFeePolicy().catch(() => null);
    const fee = policy ? calcServiceFee(gross, policy) : 0n;
    const net = gross - fee;
    const flagged = net < MIN_CHECKOUT_NET_IDR;
    const row = await this.prisma.fiatProviderTransaction.upsert({
      where: { providerRef },
      create: {
        pid: owned.pid, accountId: toAccount, kind: "deposit", providerRef, amountIdr: gross,
        feeIdr: fee, netIdr: net, feePolicyVersion: policy?.version ?? null,
        providerStatus: "processing", ledgerStatus: "pending", settlementStatus: "pending",
        counterparty: {
          source: "webhook", feeQuote: fee.toString(), netQuote: net.toString(),
          ...(policy ? { feePolicyVersion: policy.version } : {}),
          ...(flagged ? { belowMinimumNet: true } : {}),
          ...(notifyTxStatus ? { notifyTxStatus } : {}),
          ...(checkoutShaped ? { channel: "checkout" } : {}),
        },
        providerResponse: json(body),
      },
      update: {},
    });
    // Corroborate server-side, then unlock the Saldo via the same idempotent
    // issuance path (fire-and-forget: the webhook must ack fast).
    if (checkoutShaped) {
      try {
        const corr = await this.withRetry(() => this.corroborateCheckoutPayment(providerRef), "inbound order status");
        if (corr.outcome === "paid" && await this.assertInvoiceAmountMatch(row.id, gross, corr.paidAmount, providerRef)) {
          await this.markPayment(row.id, "success", corr.raw);
          void this.issuePointsForDeposit(row.id, "webhook");
          void this.ledger.issueForDeposit(row.id, "webhook");
        } else if (corr.outcome === "expired") {
          await this.markPayment(row.id, "expired", { checkoutExpired: true });
        } else if (corr.outcome === "failed") {
          await this.markPayment(row.id, "failed", { checkoutFailed: true });
        }
        // pending/unknown/unmatched: row stays processing for a later push or poll.
      } catch (err) {
        this.logger.warn(`inbound corroboration failed for ${providerRef}: ${String(err)?.slice(0, 200)}`);
      }
      return true;
    }
    try {
      const st = await this.withRetry(() => this.sac.txStatus(providerRef), "inbound status");
      const status = mapSacStatus(st.latestTransactionStatus);
      // A FAILED-declared notify contradicting corroborated settlement is
      // ambiguous — leave processing for ops instead of bricking or issuing.
      if (status === "settled" && notifyTxStatus !== undefined && notifyTxStatus !== "SUCCESS") {
        this.logger.warn(`inbound ambiguous for ${providerRef}: declared ${notifyTxStatus} vs corroborated settled — held for review`);
        return true;
      }
      if (status === "settled") {
        await this.markPayment(row.id, "success", st.rawResponse);
        void this.issuePointsForDeposit(row.id, "webhook");
      } else if (status === "failed" || status === "refunded") {
        await this.markPayment(row.id, this.mapSacToPayment(status), st.rawResponse);
      }
      // processing/cancelled: row stays processing for a later push or poll.
    } catch (err) {
      this.logger.warn(`inbound corroboration failed for ${providerRef}: ${String(err)?.slice(0, 200)}`);
    }
    return true;
  }

  /** Match a DOKU account/VA number to its owner across all stored numbers. */
  private async findAccountByAnyNumber(number: string) {
    const accounts = await this.prisma.fiatProviderAccount.findMany({ where: { provider: PROVIDER } });
    return accounts.find((a) => this.ownedAccountNos(a).includes(number) || a.vaNumber === number) ?? null;
  }

  /** Every number DOKU may credit for this sub-account (IDR + Pending + VA + POINT legs). */
  private ownedAccountNos(a: { providerAccountId: string | null; pointAccountId: string | null; accounts: unknown; vaNumber: string | null }): string[] {
    const out = new Set<string>();
    if (a.providerAccountId) out.add(a.providerAccountId);
    if (a.pointAccountId) out.add(a.pointAccountId);
    if (a.vaNumber) out.add(a.vaNumber);
    const list = (a.accounts ?? []) as unknown;
    if (Array.isArray(list)) {
      for (const entry of list as Record<string, unknown>[]) {
        const no = (entry as Record<string, unknown>)?.accountNo;
        if (typeof no === "string" && no) out.add(no);
      }
    }
    return [...out];
  }

  private async activeFeePolicy(): Promise<FeeParams> {
    const policy = await this.prisma.fiatFeePolicy.findFirst({ where: { active: true }, orderBy: { version: "desc" } });
    if (policy) return { version: policy.version, percentBps: policy.percentBps, minIdr: policy.minIdr, maxIdr: policy.maxIdr };
    return { version: DEFAULT_FEE_POLICY.version, percentBps: DEFAULT_FEE_POLICY.percentBps, minIdr: DEFAULT_FEE_POLICY.minIdr, maxIdr: DEFAULT_FEE_POLICY.maxIdr };
  }

  private async feePolicyByVersion(version: number): Promise<FeeParams> {
    if (version > 0) {
      const row = await this.prisma.fiatFeePolicy.findUnique({ where: { version } }).catch(() => null);
      if (row) return { version: row.version, percentBps: row.percentBps, minIdr: row.minIdr, maxIdr: row.maxIdr };
    }
    return this.activeFeePolicy();
  }

  /** User-supplied amount: positive whole IDR, no floats, no signs.
   *  Checkout passes NET (minimum checked at the call site); transfers pass
   *  GROSS. */
  private parseGross(raw: string): bigint {
    let gross: bigint;
    try {
      gross = parseIdrStrict(raw, "amount");
    } catch {
      throw new BadRequestException("Amount must be whole IDR (positive integer)");
    }
    if (gross <= 0n) throw new BadRequestException("Amount must be positive");
    return gross;
  }

  /**
   * Retry helper for provider calls: retries network errors (unknown
   * outcome), 5xx and 429 with exponential backoff + jitter. 4xx (other
   * than 429) and successes throw/return immediately — never retry a
   * definitive gateway answer, and never retry register (duplicate risk).
   */
  private async withRetry<T>(fn: () => Promise<T>, what: string, attempts = 3): Promise<T> {
    let last: unknown = null;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        last = err;
        const retryable = err instanceof ProviderError && (err.httpStatus === null || err.httpStatus >= 500 || err.httpStatus === 429);
        if (!retryable || i === attempts - 1) throw err;
        const backoff = Math.min(5000, 200 * 2 ** i) + Math.floor(Math.random() * 200);
        this.logger.warn(`${what} attempt ${i + 1}/${attempts} failed — retrying in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw last;
  }

  private async requireAccount(pid: string) {
    const account = await this.prisma.fiatProviderAccount.findUnique({ where: { pid_provider: { pid, provider: PROVIDER } } });
    if (!account) throw new NotFoundException("Sub-account not registered — POST /v1/fiat/sub-accounts/accounts first");
    return account;
  }

  private async requireActive(pid: string) {
    const account = await this.requireAccount(pid);
    if (account.accountStatus !== "active") throw new BadRequestException(`Sub-account is ${account.accountStatus}`);
    return account;
  }

  private markTx(id: string, providerStatus: string, raw: unknown) {
    return this.prisma.fiatProviderTransaction.update({
      where: { id },
      data: { providerStatus, providerResponse: json(raw ?? {}) },
    });
  }

  private mapError(err: unknown, what: string): Error {
    if (err instanceof ProviderError) {
      // 429 is backpressure, not a client error — retryable upstream.
      if (err.httpStatus === 429) {
        this.logger.warn(`DOKU ${what} rate-limited`);
        return new ServiceUnavailableException(`DOKU ${what} rate-limited — retry shortly`);
      }
      // 409 means the reference already exists at DOKU — sync, don't resend.
      if (err.httpStatus === 409) {
        return new ConflictException(`DOKU ${what}: duplicate reference — sync transaction status`);
      }
      if (err.httpStatus !== null && err.httpStatus >= 400 && err.httpStatus < 500) {
        return new BadRequestException(`DOKU ${what}: ${err.gatewayMessage}`.slice(0, 300));
      }
      this.logger.error(`DOKU ${what}: ${err.gatewayMessage}`.slice(0, 300));
      return new ServiceUnavailableException(`DOKU ${what} unavailable — try again`);
    }
    return new ServiceUnavailableException("Payment gateway unreachable — try again");
  }

  private toAccountView(r: {
    accountStatus: string;
    profileId: string | null;
    providerAccountId: string | null;
    pointAccountId: string | null;
    vaNumber: string | null;
    phoneNo: string | null;
    email: string | null;
    lastBalance: string | null;
    lastBalanceAt: Date | null;
  }): SubAccountView {
    return {
      status: r.accountStatus,
      currency: "IDR",
      profileId: r.profileId,
      accountNo: r.providerAccountId,
      pointAccountNo: r.pointAccountId,
      vaNumber: r.vaNumber,
      phoneNo: r.phoneNo,
      email: r.email,
      lastBalanceIdr: r.lastBalance,
      lastBalanceAt: r.lastBalanceAt,
    };
  }

  private toTxView(r: { id: string; kind: string; providerRef: string; providerStatus: string; amountIdr: bigint; feeIdr: bigint | null; netIdr: bigint | null; providerResponse: unknown; createdAt: Date }): SubTxView {
    const paymentUrl = (r.providerResponse as Record<string, any> | null)?.response?.payment?.url;
    return {
      id: r.id, kind: r.kind, providerRef: r.providerRef, providerStatus: r.providerStatus,
      grossIdr: r.amountIdr.toString(), feeIdr: r.feeIdr?.toString() ?? null,
      netIdr: r.netIdr?.toString() ?? (r.feeIdr != null ? (r.amountIdr - r.feeIdr).toString() : null),
      paymentUrl: typeof paymentUrl === "string" && paymentUrl ? paymentUrl : null,
      feeStatus: null,
      currency: "IDR", createdAt: r.createdAt,
    };
  }

  /**
   * Batch-attach legacy fee-leg statuses (`{parentRef}-FEE` rows, unique
   * index — one query). Read-only: fee rows are history only, no retry
   * affordance. Best-effort: on DB error the views keep feeStatus null.
   */
  private async attachFeeStatus(views: SubTxView[]): Promise<SubTxView[]> {
    const parents = views.filter((v) => v.kind === "deposit" || v.kind === "transfer_internal");
    if (parents.length === 0) return views;
    try {
      const legs = await this.prisma.fiatProviderTransaction.findMany({
        where: {
          kind: "fee",
          providerRef: { in: parents.map((v) => `${v.providerRef}-FEE`) },
        },
        select: { providerRef: true, providerStatus: true },
      });
      const byParent = new Map(legs.map((l) => [l.providerRef.replace(/-FEE$/, ""), l.providerStatus]));
      return views.map((v) => ({ ...v, feeStatus: byParent.get(v.providerRef) ?? null }));
    } catch {
      return views;
    }
  }

  private toCheckoutView(
    r: { id: string; providerRef: string; providerStatus: string; amountIdr: bigint; createdAt: Date },
    payment: { paymentUrl: string; tokenId: string; expiredDate?: string },
    fee: bigint,
    policyVersion: number,
  ) {
    return {
      id: r.id,
      providerRef: r.providerRef,
      paymentUrl: payment.paymentUrl,
      tokenId: payment.tokenId,
      expiredDate: payment.expiredDate ?? null,
      grossIdr: r.amountIdr.toString(),
      feeIdr: fee.toString(),
      netIdr: (r.amountIdr - fee).toString(),
      feePolicyVersion: policyVersion,
      providerStatus: r.providerStatus,
      createdAt: r.createdAt,
    };
  }
}
