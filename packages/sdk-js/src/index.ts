import type {
  ApiError,
  Identity,
  IdentityCredential,
  LoginResponse,
  Profile,
  ProfileUpdate,
  Wallet,
} from "@peridot/types";

export interface PeridotOptions {
  baseUrl: string;
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

export class PeridotWallet {
  constructor(private client: PeridotClient) {}

  async me(): Promise<Wallet | ApiError> {
    const res = await this.client.get<Wallet>("/v1/wallet/me");
    return res.data;
  }

  async create(address: string): Promise<Wallet | ApiError> {
    const res = await this.client.post<Wallet>("/v1/wallet", { address });
    return res.data;
  }
}

class PeridotClient {
  readonly auth: PeridotAuth;
  readonly identity: PeridotIdentity;
  readonly profile: PeridotProfile;
  readonly wallet: PeridotWallet;

  constructor(private baseUrl: string, private onUnauthorized?: () => void) {
    this.auth = new PeridotAuth(this);
    this.identity = new PeridotIdentity(this);
    this.profile = new PeridotProfile(this);
    this.wallet = new PeridotWallet(this);
  }

  private async request<T>(path: string, init: RequestInit): Promise<{ ok: boolean; data: T | ApiError }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...init.headers },
    });
    if (res.status === 401) {
      // Never re-trigger the handler from auth endpoints (e.g. refresh failing) —
      // that would recurse when the handler itself calls auth.refresh().
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

export function Peridot(options: PeridotOptions): PeridotClient {
  return new PeridotClient(options.baseUrl, options.onUnauthorized);
}

export default Peridot;
