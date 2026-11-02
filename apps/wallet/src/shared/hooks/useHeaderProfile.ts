import { useEffect, useState } from "react";
import type { Profile } from "@peridotvault/pid-types";
import { usePeridot } from "../app/AppContext";
import { cachedRead } from "../data/apiCache";

export interface HeaderProfile {
  displayName: string | null;
  avatarUrl: string | null;
  level: number | null;
}

// Header identity (avatar, display name, level). Shared cached read, so the
// top bar and the desktop info rail cost one request between them.
export function useHeaderProfile(refreshKey = ""): HeaderProfile {
  const { peridot } = usePeridot();
  const [state, setState] = useState<HeaderProfile>({ displayName: null, avatarUrl: null, level: null });

  useEffect(() => {
    let alive = true;
    cachedRead("profile.me", { ttlMs: 60_000, tier: "session" }, () => peridot.profile.me())
      .then((res) => {
        if (!alive || typeof res !== "object" || res === null || "statusCode" in res) return;
        const p = res as Profile;
        setState({ displayName: p.displayName ?? null, avatarUrl: p.avatarUrl ?? null, level: p.level?.level ?? null });
      })
      .catch(() => {
        // logged out or offline — keep the fallback
      });
    return () => {
      alive = false;
    };
  }, [peridot, refreshKey]);

  return state;
}
