// Phase-1a batch queue client (ANT-762).
//
// Ownership boundary with phase-1b (Troy): this module owns `submitBatch`
// and status polling ONLY. `buildBatchExecuteData` calldata builders live in
// `packages/evm` and are owned by phase-1b — do not add builders here.
//
// Shapes are ERC-5792-adapted (`to`/`value`/`data` call objects, status handle
// shaped like `wallet_getCallsStatus`) but the transport is RELAYER-executed
// sequential single-calls, NOT EIP-4337-bundled: there is no bundler,
// no EntryPoint, no paymaster. `capabilities` is accepted as passthrough and
// echoed; capability discovery (`wallet_getCapabilities`) is unsupported.

export interface BatchCall {
  /** Target contract (checksummed 0x address; EOAs and zero address rejected). */
  to: string;
  /** Wei as decimal string — MUST be "0" in phase-1a (non-financial only). */
  value: string;
  /** Calldata (non-empty, ≥ 4-byte selector). */
  data: string;
  /** Optional per-op gas cap (decimal string); enforced if present. */
  gasLimit?: string;
  /**
   * Opaque signed single-call authorization for this op (owner/session
   * signature over the existing entrypoint). The backend forwards each
   * intent verbatim — it never re-signs and never changes auth.
   */
  intent: Record<string, unknown>;
}

export interface BatchSessionKey {
  keyAddress: string;
  sequence: number;
  /** Session expiry (unix seconds); settlement requires validUntil <= this. */
  expiresAt: number;
}

export interface BatchQuote {
  quoteId: string;
  quotedAt: string;
  expiresAt: string;
  baselineNetwork: string;
  quotedMaxTotal: string;
  feePolicyVersion: number;
  feeBps: number;
  opsHash: string;
  perOp: Array<{ index: number; networkEstimate: string }>;
}

export type BatchLifecycle =
  | "received"
  | "quoted"
  | "queued"
  | "submitted"
  | "settled"
  | "partial"
  | "failed"
  | "expired";

export interface BatchStatus {
  batchId: string;
  lifecycle: BatchLifecycle;
  atomic: boolean;
  bypassQueue: boolean;
  quoteId: string;
  settleDueAt: string;
  settledAt: string | null;
  perOp: Array<{ index: number; status: string; txHash?: string; reason?: string }>;
  fees: {
    quotedBaseline: string;
    quotedMaxTotal: string;
    actualNetwork?: string;
    userTotal?: string;
    realizedSavings?: string;
    pricing?: string;
  };
  failure?: { code: string; message: string };
}

interface ApiLike {
  get<T>(path: string): Promise<{ ok: boolean; data: T | { message?: string; code?: string } }>;
  post<T>(path: string, body?: unknown): Promise<{ ok: boolean; data: T | { message?: string; code?: string } }>;
}

const BASE = "/v1/wallet/execute/batch";

function unwrap<T>(res: { ok: boolean; data: unknown }, what: string): T {
  if (!res.ok) {
    const msg = (res.data as { message?: string } | null)?.message ?? "request failed";
    throw new Error(`${what} failed: ${msg}`);
  }
  return res.data as T;
}

/** Locked pass-through quote for a batch (quoteId binds the exact op list). */
export async function estimateBatch(
  api: ApiLike,
  input: { from: string; ops: BatchCall[]; atomic?: boolean; sessionKey?: BatchSessionKey; capabilities?: Record<string, unknown> },
): Promise<BatchQuote> {
  void input.capabilities;
  const res = await api.post<BatchQuote>(`${BASE}/quote`, input);
  return unwrap(res, "estimateBatch");
}

export interface SubmitBatchInput {
  from: string;
  ops: BatchCall[];
  atomic?: boolean;
  sessionKey?: BatchSessionKey;
  quoteId: string;
  /** Dedupe + replay guard (duplicate key returns the original batch). */
  idempotencyKey: string;
  /** Urgent flows skip the timed flush and settle immediately (still sequential). */
  bypassQueue?: boolean;
  capabilities?: Record<string, unknown>;
}

/** Submit a batch: enqueue for the timed flush, or settle now with bypassQueue. */
export async function submitBatch(api: ApiLike, input: SubmitBatchInput): Promise<BatchStatus> {
  const res = await api.post<BatchStatus>(`${BASE}/submit`, input);
  return unwrap(res, "submitBatch");
}

/** Batch lifecycle + per-op results + fee settlement. */
export async function getBatchStatus(api: ApiLike, batchId: string): Promise<BatchStatus> {
  const res = await api.get<BatchStatus>(`${BASE}/${batchId}`);
  return unwrap(res, "getBatchStatus");
}

/** Cancel a queued batch (queued only — settles to expired, fee-free). */
export async function cancelQueuedBatch(api: ApiLike, batchId: string): Promise<BatchStatus> {
  const res = await api.post<BatchStatus>(`${BASE}/${batchId}/cancel`, {});
  return unwrap(res, "cancelQueuedBatch");
}

const TERMINAL: ReadonlySet<BatchLifecycle> = new Set(["settled", "partial", "failed", "expired"]);

/**
 * Poll getBatchStatus until a terminal lifecycle or the attempt budget runs
 * out (relayer-executed tracking — not 4337 `wallet_getCallsStatus` polling
 * against a bundler). Rejects on timeout with the last-seen status attached.
 */
export async function pollBatchStatus(
  api: ApiLike,
  batchId: string,
  opts: { intervalMs?: number; maxAttempts?: number } = {},
): Promise<BatchStatus> {
  const intervalMs = opts.intervalMs ?? 2000;
  const maxAttempts = opts.maxAttempts ?? 30;
  let last: BatchStatus | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    last = await getBatchStatus(api, batchId);
    if (TERMINAL.has(last.lifecycle)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const err = new Error(`pollBatchStatus timed out after ${maxAttempts} attempts (last: ${last?.lifecycle ?? "unknown"})`);
  (err as { lastStatus?: BatchStatus }).lastStatus = last;
  throw err;
}
