import { useCallback, useEffect, useState } from "react";
import { Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ChevronRight, Settings } from "../icons";
import type { Profile } from "@peridotvault/pid-types";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";

export function ProfileScreen({
  onLogout,
  goSettings,
  goEditProfile,
}: {
  onLogout: () => void;
  goSettings: () => void;
  goEditProfile: () => void;
}) {
  const { peridot } = usePeridot();
  const [profile, setProfile] = useState<Profile | null>(null);

  const load = useCallback(async () => {
    const res = await peridot.profile.me();
    if ("statusCode" in res) return;
    setProfile(res as Profile);
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Text style={s.title}>Profile</Text>

      <TouchableOpacity style={styles.row} onPress={goEditProfile}>
        {profile?.avatarUrl ? (
          <Image source={{ uri: profile.avatarUrl }} style={styles.thumb} />
        ) : (
          <View style={[styles.thumb, styles.thumbFallback]}>
            <Text style={styles.thumbText}>
              {(profile?.displayName ?? profile?.username ?? "?").slice(0, 1).toUpperCase()}
            </Text>
          </View>
        )}
        <Text style={styles.rowLabel}>Edit Profile</Text>
        <ChevronRight size={16} color={theme.colors.mutedForeground} />
      </TouchableOpacity>

      <TouchableOpacity style={styles.row} onPress={goSettings}>
        <View style={styles.rowIcon}>
          <Settings size={18} color={theme.colors.foreground} />
        </View>
        <Text style={styles.rowLabel}>Settings</Text>
        <ChevronRight size={16} color={theme.colors.mutedForeground} />
      </TouchableOpacity>

      <UIButton title="Sign Out" onPress={onLogout} variant="danger" />
    </ScrollView>
  );
}

const c = theme.colors;
const f = theme.fonts;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  container: { padding: 24, gap: 12 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  thumb: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: c.border,
  },
  thumbFallback: {
    backgroundColor: c.muted,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 0,
  },
  thumbText: { fontSize: 15, fontWeight: "400", color: c.foreground, fontFamily: f.serif },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: c.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  rowLabel: { flex: 1, fontSize: 15, fontWeight: "500", color: c.foreground, fontFamily: f.sansMedium },
});
