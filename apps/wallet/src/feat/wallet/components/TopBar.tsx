import { useEffect, useState } from "react";
import { Text, View } from "../../../shared/primitives";
import type { Identity, Profile } from "@peridotvault/pid-types";
import { usePeridot } from "../../../shared/AppContext";
import { useNetworkMode } from "../../../shared/hooks/useNetworkMode";
import { HomeHeader } from "./HomeHeader";

// Persistent identity top bar (shell chrome, like the tab bar): pid,
// display name, connections shortcut. Mounted once by the shell on tab
// roots so it never unmounts on navigation. Self-fetches like TabBar.
// Carries the persistent TESTNET badge (ANT-15 safety req 4).
export function TopBar({ onConnections, refreshKey }: { onConnections: () => void; refreshKey: string }) {
  const { peridot } = usePeridot();
  const net = useNetworkMode();
  const [pid, setPid] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    peridot.profile
      .me()
      .then((res) => {
        if (!alive || typeof res !== "object" || res === null || "statusCode" in res) return;
        setDisplayName((res as Profile).displayName ?? null);
      })
      .catch(() => {
        // logged out or offline — keep the fallback
      });
    peridot.identity
      .me()
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
    <View className="gap-2 px-6 pb-2 pt-5">
      <HomeHeader pid={pid} displayName={displayName} onConnections={onConnections} />
      {net.testnet && (
        <View className="self-start border border-border bg-muted px-2 py-1">
          <Text className="font-sans text-[11px] font-bold tracking-[1px] text-foreground">TESTNET</Text>
        </View>
      )}
    </View>
  );
}
