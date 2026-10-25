import type { ApiError, Identity, IdentityCredential } from "@peridotvault/pid-types";
import type { PeridotClient } from "./client.js";

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

  /** Soft-delete the Peridot ID (revokes all sessions). */
  async deleteAccount(): Promise<boolean> {
    const res = await this.client.delete("/v1/identity/me");
    return res.ok;
  }
}
