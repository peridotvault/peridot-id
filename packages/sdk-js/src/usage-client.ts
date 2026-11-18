import type { ApiError, UsageReport } from "@peridotvault/pid-types";

/** Minimal surface PeridotUsage needs — same shape as PeridotLevel. */
interface ApiLike {
  get<T>(path: string): Promise<{ ok: boolean; data: T | ApiError }>;
}

/**
 * Web3 usage reporting (stage 5 of docs/plan/05): owner-scoped, per registered
 * app, per UTC month. The free allowance is shown; nothing is charged and
 * nothing is blocked at the limit.
 */
export class PeridotUsage {
  constructor(private readonly client: ApiLike) {}

  /** Monthly usage for one app the caller owns. `month` is `YYYY-MM` (UTC); default: this month. */
  async monthly(appId: string, month?: string): Promise<UsageReport | ApiError> {
    const query = month ? `?month=${encodeURIComponent(month)}` : "";
    const res = await this.client.get<UsageReport>(`/v1/apps/${appId}/usage${query}`);
    return res.data;
  }
}
