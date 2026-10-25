import type { ApiError, Profile, ProfileUpdate } from "@peridotvault/pid-types";
import type { PeridotClient } from "./client.js";

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
