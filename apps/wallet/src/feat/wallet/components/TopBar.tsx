import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { Identity, Profile } from "@peridotvault/pid-types";
import { usePeridot } from "../../../shared/AppContext";
import { HomeHeader } from "./HomeHeader";

// Persistent identity top bar (shell chrome, like the tab bar): pid,
// display name, connections shortcut. Mounted once by the shell on tab
// roots so it never unmounts on navigation. Self-fetches like TabBar.
export function TopBar({ onConnections, refreshKey }: { onConnections: () => void; refreshKey: string }) {
  const { peridot } = usePeridot();
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
    <View style={styles.bar}>
      <HomeHeader pid={pid} displayName={displayName} onConnections={onConnections} />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: 24, paddingTop: 20, paddingBottom: 8 },
});
