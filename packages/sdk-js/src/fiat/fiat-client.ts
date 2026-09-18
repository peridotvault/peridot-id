// Fiat-only IDR ledger client (DOKU Checkout) — mirrors the /v1/fiat API surface.

import type { ApiError } from "@peridotvault/pid-types";
import type { FiatBalance, TopupView, WithdrawView } from "@peridotvault/pid-payments";

export type { FiatBalance, TopupView, WithdrawView };

interface ApiLike {
  get<T>(path: string): Promise<{ ok: boolean; data: T | ApiError }>;
  post<T>(path: string, body?: unknown): Promise<{ ok: boolean; data: T | ApiError }>;
}

function unwrap<T>(res: { ok: boolean; data: T | ApiError }, fallback: string): T {
  if (!res.ok || "statusCode" in (res.data as object)) {
    const msg = (res.data as ApiError)?.message ?? fallback;
    throw new Error(Array.isArray(msg) ? msg.join(" ") : msg);
  }
  return res.data as T;
}

export class PeridotFiat {
  constructor(private readonly api: ApiLike) {}

  /** Create an IDR top-up invoice — returns the DOKU hosted page URL. */
  async createTopup(amountIdr: string): Promise<TopupView> {
    return unwrap(await this.api.post<TopupView>("/v1/fiat/topup", { amountIdr }), "Top-up failed");
  }

  /** Top-up history (newest first). */
  async topups(): Promise<TopupView[]> {
    return unwrap(await this.api.get<TopupView[]>("/v1/fiat/topup"), "Failed to load top-ups");
  }

  async topup(id: string): Promise<TopupView> {
    return unwrap(await this.api.get<TopupView>(`/v1/fiat/topup/${id}`), "Top-up not found");
  }

  /** IDR withdraw request (MVP: manual settlement, status stays pending). */
  async requestWithdraw(
    amountIdr: string,
    destination?: { bankCode?: string; accountNumber?: string; accountName?: string },
  ): Promise<WithdrawView> {
    return unwrap(
      await this.api.post<WithdrawView>("/v1/fiat/withdraw", { amountIdr, ...destination }),
      "Withdraw request failed",
    );
  }

  async withdraws(): Promise<WithdrawView[]> {
    return unwrap(await this.api.get<WithdrawView[]>("/v1/fiat/withdraw"), "Failed to load withdraws");
  }

  /** Spendable IDR balance (paid top-ups minus pending + settled withdraws). */
  async balance(): Promise<FiatBalance> {
    return unwrap(await this.api.get<FiatBalance>("/v1/fiat/balance"), "Failed to load balance");
  }
}
