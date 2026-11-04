import type { ApiError, Profile, ProfileUpdate } from "@peridotvault/pid-types";
import type { PeridotClient } from "./client.js";
import { CACHE_TTL, cachedRead, invalidateCache } from "./internal/cache.js";

export class PeridotProfile {
  constructor(private client: PeridotClient) {}

  async me(): Promise<Profile | ApiError> {
    return cachedRead("profile.me", CACHE_TTL.session, async () => {
      const res = await this.client.get<Profile>("/v1/profile/me");
      return res.data;
    });
  }

  async update(input: ProfileUpdate): Promise<Profile | ApiError> {
    const res = await this.client.patch<Profile>("/v1/profile", input);
    if (res.ok) invalidateCache("profile.");
    return res.data;
  }
}
