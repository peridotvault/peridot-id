import type {
  ApiError,
  Authority,
  Identity,
  IdentityCredential,
  LoginResponse,
  Profile,
  ProfileUpdate,
  RegisterStart,
} from "@peridotvault/pid-types";
import { PeridotWallet, type PeridotWalletOptions } from "./wallet/wallet-client";
import { registerPasskey, BrowserPasskeySigner } from "./wallet/passkey";
import { FeePayerManager, type SecretStore } from "./wallet/fee-payer";

export { PeridotWallet, type PeridotWalletOptions };
export { BrowserPasskeySigner, registerPasskey };
export { FeePayerManager, type SecretStore };

export interface PeridotOptions {
  baseUrl: string;
  /** Solana RPC endpoint (devnet/local) used for smart-account transactions. */
  solanaRpcUrl: string | string[];
  /** Fee-payer secure storage (defaults to an in-memory store). */
  feePayerStore?: SecretStore;
  onUnauthorized?: () => void;
}

export class PeridotAuth {
  constructor(private client: PeridotClient) {}

  async login(): Promise<void> {
    const res = await this.client.post<LoginResponse>("/v1/auth/login");
    if (res.ok) window.location.assign((res.data as LoginResponse).url);
  }

  async logout(): Promise<void> {
    await this.client.post("/v1/auth/logout");
  }

  async refresh(): Promise<boolean> {
    const res = await this.client.post("/v1/auth/refresh");
    return res.ok;
  }
}

export class PeridotIdentity {
  constructor(private client: PeridotClient) {}

  async me(): Promise<Identity | ApiError> {
    const res = await this.client.get<Identity>("/v1/identity/me");
    return res.data;
  }

  async credentials(): Promise<IdentityCredential[] | ApiError> {
    const res = await this.client.get<IdentityCredential[]>("/v1/identity/credentials");
    return res.data;
  }

  async unlinkCredential(id: string): Promise<boolean> {
    const res = await this.client.delete(`/v1/identity/credentials/${id}`);
    return res.ok;
  }
}

export class PeridotProfile {
  constructor(private client: PeridotClient) {}

  async me(): Promise<Profile | ApiError> {
    const res = await this.client.get<Profile>("/v1/profile/me");
    return res.data;
  }

  async update(input: ProfileUpdate): Promise<Profile | ApiError> {
    const res = await this.client.patch<Profile>("/v1/profile", input);
    return res.data;
  }
}

/** Passkey credential management (task 003 ceremonies, wrapped for convenience). */
export class PeridotPasskey {
  constructor(private client: PeridotClient) {}

  async list(): Promise<Authority[] | ApiError> {
    const res = await this.client.get<Authority[]>("/v1/credentials");
    return res.data;
  }

  async register(): Promise<Authority> {
    return registerPasskey({
      registerStart: async () => {
        const res = await this.client.post<RegisterStart>("/v1/credentials/register/start");
        if (!res.ok) throw new Error("Gagal memulai registrasi passkey");
        return res.data as RegisterStart;
      },
      registerFinish: async (input) => {
        const res = await this.client.post<Authority>("/v1/credentials/register/finish", input);
        return res.data;
      },
    });
  }

  async revoke(id: string): Promise<Authority | ApiError> {
    const res = await this.client.delete<Authority>(`/v1/credentials/${id}`);
    return res.data;
  }
}

class PeridotClient {
  readonly auth: PeridotAuth;
  readonly identity: PeridotIdentity;
  readonly profile: PeridotProfile;
  readonly passkey: PeridotPasskey;
  readonly wallet: PeridotWallet;

  constructor(private baseUrl: string, walletOptions: PeridotWalletOptions, private onUnauthorized?: () => void) {
    this.auth = new PeridotAuth(this);
    this.identity = new PeridotIdentity(this);
    this.profile = new PeridotProfile(this);
    this.passkey = new PeridotPasskey(this);
    this.wallet = new PeridotWallet(this, walletOptions);
  }

  private async request<T>(path: string, init: RequestInit): Promise<{ ok: boolean; data: T | ApiError }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...init.headers },
    });
    if (res.status === 401) {
      if (!path.startsWith("/v1/auth/")) this.onUnauthorized?.();
      return { ok: false, data: { statusCode: 401, message: "Unauthorized" } };
    }
    const data = res.status === 204 || !res.headers.get("content-type")?.includes("application/json")
      ? ({} as T)
      : await res.json();
    return { ok: res.ok, data };
  }

  get<T>(path: string) {
    return this.request<T>(path, { method: "GET" });
  }

  post<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
  }

  patch<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
  }

  delete<T>(path: string) {
    return this.request<T>(path, { method: "DELETE" });
  }
}

export { PeridotClient };
export function Peridot(options: PeridotOptions): PeridotClient {
  return new PeridotClient(options.baseUrl, { solanaRpcUrl: options.solanaRpcUrl, feePayerStore: options.feePayerStore }, options.onUnauthorized);
}

export default Peridot;