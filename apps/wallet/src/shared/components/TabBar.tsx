import { useEffect, useState } from "react";
import { Image, Pressable, Text, View } from "../primitives";
import { Activity, House } from "../icons";
import { usePeridot } from "../AppContext";
import { useWideLayout } from "../hooks/useWideLayout";

export type TabKey = "home" | "activity" | "profile";

// Bottom tab bar — shown on the three tab roots only (home/activity/
// profile). Pushes (send, settings stack, …) render full-screen above it.
// The Profile tab shows the user's photo (initial fallback), refetched on
// every tab switch so edits appear without extra wiring.
//
// Styled with Tailwind (tokens in src/index.css @theme, same values as
// shared/theme.ts). flexDirection stays a style prop: the primitives shim
// emits it inline, which beats any class.
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
        setInitial(((res.displayName ?? "?") as string).slice(0, 1).toUpperCase());
      })
      .catch(() => {
        // logged out or offline — keep the fallback
      });
    return () => {
      alive = false;
    };
  }, [peridot, current]);

  const profileActive = current === "profile";
  const wide = useWideLayout();

  if (wide) {
    return (
      <View className="w-[232px] gap-1 bg-background px-3 py-5">
        <Tab side icon={House} label="Home" active={current === "home"} onPress={() => go("home")} />
        <Tab side icon={Activity} label="Activity" active={current === "activity"} onPress={() => go("activity")} />
        <Pressable onPress={() => go("profile")} accessibilityState={{ selected: profileActive }}>
          <View
            style={{ flexDirection: "row" }}
            className={`w-full items-center gap-3 p-3 ${profileActive ? "bg-muted" : ""}`}
          >
            <ProfileAvatar uri={avatarUrl} initial={initial} active={profileActive} />
            <Text className={`font-sans text-sm font-medium ${profileActive ? "text-foreground" : "text-muted-foreground"}`}>
              Profile
            </Text>
          </View>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flexDirection: "row" }} className="border-t border-border bg-background pb-3.5 pt-2.5">
      <Tab icon={House} label="Home" active={current === "home"} onPress={() => go("home")} />
      <Tab icon={Activity} label="Activity" active={current === "activity"} onPress={() => go("activity")} />
      <Pressable onPress={() => go("profile")} accessibilityState={{ selected: profileActive }} className="flex-1">
        <View className="w-full items-center gap-1">
          <ProfileAvatar uri={avatarUrl} initial={initial} active={profileActive} />
          <Text className={`font-sans text-[11px] font-medium ${profileActive ? "text-foreground" : "text-muted-foreground"}`}>
            Profile
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

function Tab({
  icon: Icon,
  label,
  active,
  onPress,
  side,
}: {
  icon: typeof House;
  label: string;
  active: boolean;
  onPress: () => void;
  side?: boolean;
}) {
  const tone = active ? "text-foreground" : "text-muted-foreground";
  return (
    <Pressable
      onPress={onPress}
      accessibilityState={{ selected: active }}
      className={side ? undefined : "flex-1"}
    >
      <View
        style={side ? { flexDirection: "row" } : undefined}
        className={side ? `w-full items-center gap-3 p-3 ${active ? "bg-muted" : ""}` : "w-full items-center gap-1"}
      >
        <Icon size={20} className={tone} />
        <Text className={`font-sans font-medium ${side ? "text-sm" : "text-[11px]"} ${tone}`}>{label}</Text>
      </View>
    </Pressable>
  );
}

function ProfileAvatar({ uri, initial, active }: { uri: string | null; initial: string; active: boolean }) {
  if (uri) {
    return (
      <Image
        source={{ uri }}
        className={`h-6 w-6 rounded-full border ${active ? "border-foreground" : "border-border"}`}
      />
    );
  }
  return (
    <View className="h-6 w-6 items-center justify-center rounded-full bg-muted">
      <Text className="font-serif text-xs text-foreground">{initial}</Text>
    </View>
  );
}
