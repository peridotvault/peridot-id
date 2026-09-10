import { useEffect, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { Activity, House } from "lucide-react-native";
import { usePeridot } from "../AppContext";
import { theme } from "../theme";

export type TabKey = "home" | "activity" | "profile";

// Bottom tab bar — shown on the three tab roots only (home/activity/
// profile). Pushes (send, settings stack, …) render full-screen above it.
// The Profile tab shows the user's photo (initial fallback), refetched on
// every tab switch so edits appear without extra wiring.
export function TabBar({ current, go }: { current: TabKey; go: (s: TabKey) => void }) {
  const { peridot } = usePeridot();
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [initial, setInitial] = useState("?");

  useEffect(() => {
    let alive = true;
    peridot
      .profile.me()
      .then((res) => {
        if (!alive || typeof res !== "object" || res === null || "statusCode" in res) return;
        setAvatarUrl(res.avatarUrl ?? null);
        setInitial(((res.displayName ?? res.username ?? "?") as string).slice(0, 1).toUpperCase());
      })
      .catch(() => {
        // logged out or offline — keep the fallback
      });
    return () => {
      alive = false;
    };
  }, [peridot, current]);

  const profileActive = current === "profile";

  return (
    <View style={styles.bar}>
      <Tab icon={House} label="Home" active={current === "home"} onPress={() => go("home")} />
      <Tab icon={Activity} label="Activity" active={current === "activity"} onPress={() => go("activity")} />
      <Pressable onPress={() => go("profile")} style={styles.tab} accessibilityState={{ selected: profileActive }}>
        {avatarUrl ? (
          <Image source={{ uri: avatarUrl }} style={[styles.avatar, profileActive && styles.avatarActive]} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback, profileActive && styles.avatarActive]}>
            <Text style={styles.avatarText}>{initial}</Text>
          </View>
        )}
        <Text style={[styles.label, profileActive && styles.labelActive]}>Profile</Text>
      </Pressable>
    </View>
  );
}

function Tab({
  icon: Icon,
  label,
  active,
  onPress,
}: {
  icon: typeof House;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const color = active ? theme.colors.foreground : theme.colors.mutedForeground;
  return (
    <Pressable onPress={onPress} style={styles.tab} accessibilityState={{ selected: active }}>
      <Icon size={20} color={color} />
      <Text style={[styles.label, active && styles.labelActive]}>{label}</Text>
    </Pressable>
  );
}

const c = theme.colors;
const f = theme.fonts;

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: c.border,
    backgroundColor: c.background,
    paddingTop: 10,
    paddingBottom: 14,
  },
  tab: { flex: 1, alignItems: "center", gap: 4 },
  label: { fontSize: 11, color: c.mutedForeground, fontFamily: f.sansMedium },
  labelActive: { color: c.foreground },
  avatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
  },
  avatarActive: { borderColor: c.foreground },
  avatarFallback: {
    backgroundColor: c.muted,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 0,
  },
  avatarText: { fontSize: 12, color: c.foreground, fontFamily: f.serif },
});
