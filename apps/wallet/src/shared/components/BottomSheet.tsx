import type { ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { X } from "../icons";

// Shared bottom drawer: slide-up sheet capped at the sm width and centered.
// ponytail: marginHorizontal auto is the centering fix — left:0/right:0 alone
// pins an absolute view full-bleed, so maxWidth without it never centers.
export function BottomSheet({
  visible,
  title,
  onClose,
  closeDisabled,
  scrimLabel,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  closeDisabled?: boolean;
  scrimLabel?: string;
  children: ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={styles.scrim}
        onPress={closeDisabled ? undefined : onClose}
        accessibilityLabel={scrimLabel ?? `Close ${title}`}
      />
      <View style={styles.sheet}>
        <View style={styles.head}>
          <Text style={styles.title}>{title}</Text>
          <Pressable onPress={onClose} disabled={closeDisabled} style={styles.close} accessibilityLabel="Close">
            <X size={18} color={theme.colors.mutedForeground} />
          </Pressable>
        </View>
        {children}
      </View>
    </Modal>
  );
}

const c = theme.colors;
const f = theme.fonts;

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0, 0, 0, 0.6)" },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    maxWidth: theme.layout.maxWidth,
    marginHorizontal: "auto",
    alignSelf: "center",
    maxHeight: "75%",
    backgroundColor: c.surface,
    borderTopWidth: 1,
    borderColor: c.border,
    padding: 20,
    paddingBottom: 28,
    gap: 12,
  },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: 22, color: c.foreground, fontFamily: f.serif, letterSpacing: -0.3 },
  close: { padding: 6 },
});
