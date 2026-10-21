import type { ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "../primitives";
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
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} label={title}>
      <Pressable
        style={styles.scrim}
        onPress={closeDisabled ? undefined : onClose}
        accessibilityLabel={scrimLabel ?? `Close ${title}`}
      />
      <View
        className="absolute bottom-0 left-0 right-0 mx-auto max-h-[75%] w-full max-w-[576px] gap-3 self-center border-t border-border bg-surface p-5 pb-7"
        style={{ overflowY: "auto" }}
      >
        <View style={{ flexDirection: "row" }} className="items-center justify-between">
          <Text className="font-serif text-[22px] tracking-[-0.3px] text-foreground">{title}</Text>
          <Pressable onPress={onClose} disabled={closeDisabled} accessibilityLabel="Close">
            <View className="p-1.5">
              <X size={18} className="text-muted-foreground" />
            </View>
          </Pressable>
        </View>
        {children}
      </View>
    </Modal>
  );
}

// The scrim keeps a stylesheet: it is a Pressable whose dim background must
// beat the shim's inline `background: none` — no class can do that.
const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0, 0, 0, 0.6)" },
});
