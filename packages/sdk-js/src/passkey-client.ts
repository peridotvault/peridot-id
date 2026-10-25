import type { ApiError, Authority, RegisterStart } from "@peridotvault/pid-types";
import { PasskeyHostedRequiredError, registerPasskey } from "@peridotvault/pid-core";
import type { PeridotClient } from "./client.js";

/** Passkey credential management (task 003 ceremonies, wrapped for convenience). */
export class PeridotPasskey {
  constructor(private client: PeridotClient) {}

  async list(): Promise<Authority[] | ApiError> {
    const res = await this.client.get<Authority[]>("/v1/credentials");
    return res.data;
  }

  async register(): Promise<Authority> {
    try {
      return await registerPasskey({
        registerStart: async () => {
          const res = await this.client.post<RegisterStart>("/v1/credentials/register/start");
          if (!res.ok) throw new Error("Failed to start passkey registration");
          return res.data as RegisterStart;
        },
        registerFinish: async (input) => {
          const res = await this.client.post<Authority>("/v1/credentials/register/finish", input);
          return res.data;
        },
      });
    } catch (e) {
      if (e instanceof PasskeyHostedRequiredError) {
        return this.client.popupRequest<Authority>("register");
      }
      throw e;
    }
  }

  async revoke(id: string): Promise<Authority | ApiError> {
    const res = await this.client.delete<Authority>(`/v1/credentials/${id}`);
    return res.data;
  }
}
