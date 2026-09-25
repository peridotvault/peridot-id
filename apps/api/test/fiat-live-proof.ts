// Fiat Unified-Ledger LIVE PROOF harness (sandbox only, never production).
//
// Proves the accounting movement end to end against REAL DOKU — no mocks, no
// faked payment SUCCESS, no fabricated POINT. It drives the real
// FiatSubAccountService (Nest application context) and reads raw DOKU balances
// via the real provider client.
//
// What it proves (the two PRD §8 acceptance movements):
//   Deposit  Rp105.000 → payment SUCCESS → DOKU user POINT +100.000,
//            Treasury POINT +5.000 (total +105.000); journal reflects exactly
//            that; later settlement adds zero POINT.
//   Transfer Rp40.000 A→B (fee 2.000) → A −40.000, B +38.000, Treasury +2.000;
//            journal/replay == live DOKU POINT.
//
// The provider blocker (DOKU `4004203 Source account not configured for TOPUP`)
// is NOT bypassed: `preflight` reports it and stops. This harness is built to be
// run the moment DOKU activates Unified Ledger + provisions SYSTEM_POINT.
//
// Usage (from apps/api, sandbox env in .env):
//   pnpm --filter @peridotvault/pid-api proof:fiat preflight [pidA]
//   pnpm --filter @peridotvault/pid-api proof:fiat fixture:b [pidB] [email]
//   pnpm --filter @peridotvault/pid-api proof:fiat deposit:create <pidA> <netIdr>
//   pnpm --filter @peridotvault/pid-api proof:fiat deposit:verify <ref>
//   pnpm --filter @peridotvault/pid-api proof:fiat transfer <pidA> <pidB> <grossIdr>
//
// Raw captures are written to test/.proof-out/ (gitignored, local artifacts —
// may contain account numbers; never commit them). Secrets are redacted.
//
// Exit codes: 0 all checks pass · 1 assertion failed · 2 provider/config
// blocked · 3 payment not completed yet (re-run later).

import "reflect-metadata";
import { Module, type INestApplicationContext } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DokuSubAccountProvider, ProviderError, parseIdrStrict } from "@peridotvault/pid-payments";
import { PrismaModule } from "../src/prisma/prisma.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { SecurityModule } from "../src/security/security-event.module";
import { FiatModule } from "../src/fiat/fiat.module";
import { FiatSubAccountService } from "../src/fiat/fiat-subaccount.service";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // The fiat controller carries @UseGuards(ThrottlerGuard); the context
    // must provide its options even though no HTTP server runs.
    ThrottlerModule.forRoot([{ name: "default", ttl: 60000, limit: 100 }]),
    PrismaModule,
    SecurityModule,
    FiatModule,
  ],
})
class ProofModule {}

const OUT_DIR = join(__dirname, ".proof-out");
const POINT = "DOKU_MERCHANT_POINT";
const PROVIDER = "doku-sub-account";
const TERMINAL = ["success", "settled", "failed", "cancelled", "expired"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- capture (local, redacted) ---------------------------------------------

const SECRET_KEY = /secret|privatekey|private_key|clientid|client_id|accesstoken|access_token|signature|authorization/i;
function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(val);
    return out;
  }
  return v;
}
function stringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val), 2);
}
function capture(label: string, data: unknown): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(OUT_DIR, `${stamp}-${label}.json`);
  writeFileSync(file, stringify({ capturedAt: new Date().toISOString(), label, data: redact(data) }));
  return file;
}
const statePath = (ref: string) => join(OUT_DIR, `state-deposit-${ref}.json`);

// --- context ----------------------------------------------------------------

interface Ctx {
  app: INestApplicationContext;
  service: FiatSubAccountService;
  prisma: PrismaService;
  config: ConfigService;
  sac: DokuSubAccountProvider;
}

async function boot(): Promise<Ctx> {
  const app = await NestFactory.createApplicationContext(ProofModule, { logger: ["error", "warn"] });
  const config = app.get(ConfigService);
  const sac = new DokuSubAccountProvider({
    mode: config.get<string>("DOKU_MODE", "sandbox") === "production" ? "production" : "sandbox",
    clientId: config.get<string>("DOKU_CLIENT_ID", ""),
    secretKey: config.get<string>("DOKU_SECRET_KEY", ""),
    privateKey: config.get<string>("DOKU_PRIVATE_KEY", ""),
  });
  return { app, config, sac, service: app.get(FiatSubAccountService), prisma: app.get(PrismaService) };
}

type Balance = { accountNo: string | null; available: bigint; reserved: bigint; raw: unknown } | null;

const accountRow = (ctx: Ctx, pid: string) =>
  ctx.prisma.fiatProviderAccount.findUnique({ where: { pid_provider: { pid, provider: PROVIDER } } });

async function pointBalance(ctx: Ctx, profileId: string | null | undefined): Promise<Balance> {
  if (!profileId) return null;
  const bal = await ctx.sac.balance(profileId);
  const acc = bal.accounts.find((a) => a.type === POINT);
  if (!acc) return { accountNo: null, available: 0n, reserved: 0n, raw: bal.rawResponse };
  return { accountNo: acc.accountNo, available: parseIdrStrict(acc.available, "point.available"), reserved: parseIdrStrict(acc.reserved, "point.reserved"), raw: bal.rawResponse };
}
async function userPoint(ctx: Ctx, pid: string): Promise<Balance> {
  const row = await accountRow(ctx, pid);
  return pointBalance(ctx, row?.profileId);
}
async function treasuryPoint(ctx: Ctx): Promise<Balance> {
  const profileId = ctx.config.get<string>("DOKU_TREASURY_PROFILE_ID", "");
  return profileId ? pointBalance(ctx, profileId) : null;
}
const toBig = (v: unknown): bigint => {
  try {
    return v == null ? 0n : BigInt(v as bigint | string | number);
  } catch {
    return 0n;
  }
};
const delta = (before: Balance, after: Balance) => toBig(after?.available) - toBig(before?.available);

// --- checks -----------------------------------------------------------------

interface Check { name: string; ok: boolean; actual: string; expected: string }
function makeChecks() {
  const checks: Check[] = [];
  const check = (name: string, actual: bigint | string | boolean | number, expected: bigint | string | boolean | number) => {
    const a = typeof actual === "bigint" ? actual.toString() : String(actual);
    const e = typeof expected === "bigint" ? expected.toString() : String(expected);
    checks.push({ name, ok: a === e, actual: a, expected: e });
  };
  return { checks, check };
}

async function journal(ctx: Ctx, ref: string, pids: string[]) {
  return ctx.prisma.fiatProviderTransaction.findMany({
    where: {
      pid: { in: pids },
      OR: [{ providerRef: { startsWith: ref } }, { counterparty: { path: ["parentRef"], equals: ref } }],
    },
    orderBy: { replaySeq: "asc" },
    select: {
      providerRef: true, pid: true, kind: true, providerStatus: true, ledgerStatus: true,
      amountIdr: true, direction: true, entryGroup: true, settlementStatus: true, counterparty: true,
    },
  });
}
const findLeg = (rows: Awaited<ReturnType<typeof journal>>, kind: string, providerRef: string) =>
  rows.find((r) => r.kind === kind && r.providerRef === providerRef);

const window7d = () => ({
  fromDateTime: new Date(Date.now() - 7 * 24 * 3600_000).toISOString().slice(0, 10),
  toDateTime: new Date().toISOString().slice(0, 10),
});

function report(label: string, checks: Check[], extra: Record<string, unknown>, exit: number) {
  const file = capture(label, { checks, extra });
  console.log(`\n=== ${label} ===`);
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}  (actual=${c.actual} expected=${c.expected})`);
  console.log(`capture: ${file}`);
  console.log(`exit=${exit}`);
  process.exitCode = exit;
}

// --- commands ---------------------------------------------------------------

async function preflight(ctx: Ctx, pidA?: string) {
  const flag = ctx.config.get<string>("PID_UNIFIED_LEDGER_ACTIVE", "false") === "true";
  const systemPoint = ctx.config.get<string>("DOKU_SYSTEM_POINT_ACCOUNT_NO", "");
  const treasury = ctx.config.get<string>("DOKU_TREASURY_POINT_ACCOUNT_NO", "") || ctx.config.get<string>("DOKU_TREASURY_PROFILE_ID", "");
  const mode = ctx.config.get<string>("DOKU_MODE", "sandbox");

  const aRow = pidA ? await accountRow(ctx, pidA) : null;
  const target = aRow?.pointAccountId ?? null;
  let probe: { outcome: string; detail: string };
  if (!systemPoint) {
    probe = { outcome: "blocked", detail: "DOKU_SYSTEM_POINT_ACCOUNT_NO not configured" };
  } else if (!target) {
    probe = { outcome: "skipped", detail: "no target POINT account — pass pidA or run fixture:b first" };
  } else {
    try {
      const ref = `PROBE${Date.now().toString(36).toUpperCase()}`;
      const inq = await ctx.sac.transferInquiry({
        partnerReferenceNo: ref, type: "DOKU_NON_FIAT", amountIdr: 1n, currency: "POINT",
        fromAccount: systemPoint, beneficiaryAccountNumber: target,
        remark: "PeridotID proof preflight (inquiry only — no payment executed)",
      });
      probe = { outcome: "ok", detail: `referenceNo=${inq.referenceNo}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      probe = { outcome: /4004203|not configured for TOPUP/i.test(msg) ? "blocked" : "error", detail: msg.slice(0, 300) };
    }
  }

  const balances = { A: pidA ? await userPoint(ctx, pidA).catch(() => null) : null, treasury: await treasuryPoint(ctx).catch(() => null) };
  const { checks, check } = makeChecks();
  check("mode is sandbox", mode === "sandbox", true);
  check("PID_UNIFIED_LEDGER_ACTIVE=true", flag, true);
  check("DOKU_SYSTEM_POINT_ACCOUNT_NO configured", !!systemPoint, true);
  check("NON_FIAT TOPUP reachable (no 4004203)", probe.outcome === "ok", true);
  const blocked = !flag || !systemPoint || probe.outcome === "blocked" || probe.outcome === "error";
  report("preflight", checks, { mode, flag, systemPointConfigured: !!systemPoint, treasuryConfigured: !!treasury, targetPointAccount: target, probe, balances }, blocked ? 2 : 0);
}

async function fixtureB(ctx: Ctx, pidB: string, email: string) {
  await ctx.prisma.identity.upsert({ where: { pid: pidB }, create: { pid: pidB }, update: {} });
  const view = await ctx.service.registerAccount(pidB, { name: pidB, email });
  const row = await accountRow(ctx, pidB);
  capture("fixture-b", { pidB, email, view, account: row ? { profileId: row.profileId, pointAccountId: row.pointAccountId, accountStatus: row.accountStatus } : null });
  console.log(`B ready: ${pidB} profileId=${view.profileId} pointAccountNo=${view.pointAccountNo} status=${view.status}`);
}

async function depositCreate(ctx: Ctx, pidA: string, netStr: string) {
  const net = parseIdrStrict(netStr, "net");
  if (net < 100_000n) throw new Error("net must be >= Rp100.000");
  const before = { A: await userPoint(ctx, pidA), treasury: await treasuryPoint(ctx) };
  const res = await ctx.service.createCheckoutDeposit(pidA, netStr);
  const state = {
    ref: res.providerRef, id: res.id, pid: pidA,
    net: res.netIdr, gross: res.grossIdr, fee: res.feeIdr,
    paymentUrl: res.paymentUrl, before, createdAt: new Date().toISOString(),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(statePath(res.providerRef), stringify(redact(state)));
  capture(`deposit-create-${res.providerRef}`, state);
  console.log(`\nCheckout intent created: ${res.providerRef}`);
  console.log(`gross=Rp${res.grossIdr} net=Rp${res.netIdr} fee=Rp${res.feeIdr}`);
  console.log(`Pay this sandbox page now (manual):\n  ${res.paymentUrl}`);
  console.log(`Then run: pnpm --filter @peridotvault/pid-api proof:fiat deposit:verify ${res.providerRef}`);
}

async function depositVerify(ctx: Ctx, ref: string) {
  let state: any;
  try {
    state = JSON.parse(readFileSync(statePath(ref), "utf8"));
  } catch {
    throw new Error(`no state for ${ref} — run deposit:create first`);
  }
  // Poll payment confirmation (real Checkout order status) up to ~5 min.
  let tx: { providerStatus: string } | null = null;
  for (let i = 0; i < 20; i++) {
    try {
      tx = await ctx.service.syncTx(state.pid, state.id);
    } catch (err) {
      if (err instanceof Error && /not paid yet/i.test(err.message)) tx = null;
      else throw err;
    }
    if (tx && TERMINAL.includes(tx.providerStatus)) break;
    await sleep(15_000);
  }
  if (!tx || !TERMINAL.includes(tx.providerStatus)) {
    console.log(`Payment not completed yet for ${ref} — pay the Checkout page, then re-run deposit:verify.`);
    capture(`deposit-pending-${ref}`, { ref, last: tx });
    process.exitCode = 3;
    return;
  }
  if (tx.providerStatus !== "success" && tx.providerStatus !== "settled") {
    report("deposit-verify", [{ name: `payment status ${tx.providerStatus}`, ok: false, actual: tx.providerStatus, expected: "success" }], { ref }, 1);
    return;
  }
  // Complete any outstanding legs, then snapshot after.
  await ctx.service.adminSweep({ take: 100 });
  const after = { A: await userPoint(ctx, state.pid), treasury: await treasuryPoint(ctx) };
  const rows = await journal(ctx, ref, [state.pid]);
  const parent = await ctx.prisma.fiatProviderTransaction.findUnique({ where: { providerRef: ref } });
  const reconcile = await ctx.service.reconcile(state.pid, window7d());

  if ((parent?.ledgerStatus ?? "") !== "issued") {
    // Payment confirmed but POINT not issued → the provider/config blocker,
    // NOT an assertion failure. No fabrication happened.
    report("deposit-verify", [{ name: "ledgerStatus issued", ok: false, actual: parent?.ledgerStatus ?? "unset", expected: "issued" }],
      { ref, ledgerStatus: parent?.ledgerStatus, note: "payment confirmed but issuance deferred — check preflight (flag / SYSTEM_POINT / DOKU 4004203)" }, 2);
    return;
  }

  const userLeg = findLeg(rows, "points_issue", `${ref}-PTS`);
  const feeLeg = findLeg(rows, "points_fee", `${ref}-PTS-FEE`);
  const net = BigInt(state.net);
  const fee = BigInt(state.fee);
  const { checks, check } = makeChecks();
  check("DOKU user POINT delta", delta(state.before.A, after.A), net);
  if (state.before.treasury || after.treasury) check("DOKU Treasury POINT delta", delta(state.before.treasury, after.treasury), fee);
  check("journal points_issue NET settled", userLeg?.providerStatus ?? "missing", "settled");
  check("journal points_issue amount = NET", userLeg?.amountIdr ?? -1n, net);
  check("journal points_issue direction in", userLeg?.direction ?? "missing", "in");
  check("journal points_fee FEE settled", feeLeg?.providerStatus ?? "missing", "settled");
  check("journal points_fee amount = FEE", feeLeg?.amountIdr ?? -1n, fee);
  check("journal points_fee direction out", feeLeg?.direction ?? "missing", "out");
  check("Invariant-1 replay == live DOKU (no alerts)", reconcile.backing?.alerts?.length ?? -1, 0);
  const extra = {
    ref, gross: state.gross, net: state.net, fee: state.fee,
    before: state.before, after, ledgerStatus: parent?.ledgerStatus, settlementStatus: parent?.settlementStatus,
    journal: rows, reconcile,
    settlementNote: "settlement later must flip settlementStatus with ZERO new points_* rows — re-run reconcile after DOKU settles",
  };
  report("deposit-verify", checks, extra, checks.every((c) => c.ok) ? 0 : 1);
}

async function transfer(ctx: Ctx, pidA: string, pidB: string, grossStr: string) {
  const gross = parseIdrStrict(grossStr, "gross");
  const before = { A: await userPoint(ctx, pidA), B: await userPoint(ctx, pidB), treasury: await treasuryPoint(ctx) };
  const inq = await ctx.service.transferInquiry(pidA, { type: "DOKU_SUB_ACCOUNT", amountIdr: grossStr, beneficiaryPid: pidB });
  const res = await ctx.service.transferConfirm(pidA, inq.id, { beneficiaryAccountName: inq.accountName ?? pidB });
  await ctx.service.adminSweep({ take: 100 });
  const after = { A: await userPoint(ctx, pidA), B: await userPoint(ctx, pidB), treasury: await treasuryPoint(ctx) };
  const rows = await journal(ctx, inq.providerRef, [pidA, pidB]);
  const recA = await ctx.service.reconcile(pidA, window7d());
  const recB = await ctx.service.reconcile(pidB, window7d());

  const fee = BigInt(inq.feeIdr);
  const net = BigInt(inq.netIdr);
  const { checks, check } = makeChecks();
  check("A DOKU POINT delta", delta(before.A, after.A), -gross);
  check("B DOKU POINT delta", delta(before.B, after.B), net);
  if (before.treasury || after.treasury) check("Treasury DOKU POINT delta", delta(before.treasury, after.treasury), fee);
  const parent = findLeg(rows, "transfer_internal", inq.providerRef);
  const mirror = rows.find((r) => r.kind === "points_credit");
  const feeLeg = findLeg(rows, "points_fee", `${inq.providerRef}-PTFEE`);
  check("journal transfer_internal gross out", parent?.amountIdr ?? -1n, gross);
  check("journal transfer_internal settled", parent?.providerStatus ?? "missing", "settled");
  check("journal points_credit NET in", mirror?.amountIdr ?? -1n, net);
  check("journal points_fee FEE settled", feeLeg?.providerStatus ?? "missing", "settled");
  check("Invariant-1 A replay == live DOKU", recA.backing?.alerts?.length ?? -1, 0);
  check("Invariant-1 B replay == live DOKU", recB.backing?.alerts?.length ?? -1, 0);
  const extra = { providerRef: inq.providerRef, gross: gross.toString(), net: net.toString(), fee: fee.toString(), result: res, before, after, journal: rows, reconcileA: recA, reconcileB: recB };
  report("transfer", checks, extra, checks.every((c) => c.ok) ? 0 : 1);
}

// --- entry ------------------------------------------------------------------

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const ctx = await boot();
  try {
    switch (cmd) {
      case "preflight": return await preflight(ctx, args[0]);
      case "fixture:b": return await fixtureB(ctx, args[0] ?? "proof-b@pid", args[1] ?? "proof-b@example.com");
      case "deposit:create": return await depositCreate(ctx, args[0], args[1]);
      case "deposit:verify": return await depositVerify(ctx, args[0]);
      case "transfer": return await transfer(ctx, args[0], args[1], args[2]);
      default:
        console.log("commands: preflight [pidA] | fixture:b [pidB] [email] | deposit:create <pidA> <netIdr> | deposit:verify <ref> | transfer <pidA> <pidB> <grossIdr>");
    }
  } catch (err) {
    if (err instanceof ProviderError) {
      console.error(`PROVIDER ERROR (${err.httpStatus ?? "network"}): ${err.gatewayMessage}`);
      process.exitCode = 2;
    } else {
      console.error(err);
      process.exitCode = 1;
    }
  } finally {
    await ctx.app.close().catch(() => undefined);
  }
}

void main();
