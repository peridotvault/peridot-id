import { useEffect, useState } from "react";

import type { Identity, Profile } from "@peridotvault/pid-types";
import { usePeridot } from "../../../shared/AppContext";
import { cachedRead } from "../../../shared/api-cache";
import { useNetworkMode } from "../../../shared/hooks/useNetworkMode";
import { HomeHeader } from "./HomeHeader";

// Persistent identity top bar (shell chrome, like the tab bar): pid, display
// name, and the profile photo + level chip (opens Profile). Mounted once by
// the shell on tab roots so it never unmounts on navigation. Self-fetches —
// through the shared read cache so it reuses Home's profile/identity reads
// instead of doubling them. Carries the persistent TESTNET badge (ANT-15
// safety req 4).
export function TopBar({
  onProfile,
  refreshKey,
}: {
  onProfile: () => void;
  refreshKey: string;
}) {
  const { peridot } = usePeridot();
  const net = useNetworkMode();
  const [pid, setPid] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [level, setLevel] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    cachedRead("profile.me", { ttlMs: 60_000, tier: "session" }, () => peridot.profile.me())
      .then((res) => {
        if (!alive || typeof res !== "object" || res === null || "statusCode" in res) return;
        const p = res as Profile;
        setDisplayName(p.displayName ?? null);
        setAvatarUrl(p.avatarUrl ?? null);
        setLevel(p.level?.level ?? null);
      })
      .catch(() => {
        // logged out or offline — keep the fallback
      });
    cachedRead("identity.me", { ttlMs: 60_000, tier: "session" }, () => peridot.identity.me())
      .then((res) => {
        if (!alive || typeof res !== "object" || res === null || "statusCode" in res) return;
        setPid((res as Identity).pid);
      })
      .catch(() => {
        // logged out or offline — keep the fallback
      });
    return () => {
      alive = false;
    };
  }, [peridot, refreshKey]);

  return (
    <div className="flex flex-col gap-2 px-6 pb-2 pt-5">
      <HomeHeader pid={pid} displayName={displayName} avatarUrl={avatarUrl} level={level} onProfile={onProfile} />
      {net.testnet && (
        <div className="flex flex-col self-start border border-border bg-muted px-2 py-1">
          <span className="font-sans text-xs font-bold tracking-[1px] text-foreground">TESTNET</span>
        </div>
      )}
    </div>
  );
}
