import { Text } from "react-native";
import { styles as s, theme } from "../../../shared/theme";
import { BottomSheet } from "../../../shared/components/BottomSheet";
import { UIButton } from "../../../shared/components/UIButton";
import { ArrowUpRight, Banknote } from "../../../shared/icons";

// Send entry point: one button opens this chooser instead of routing direct.
// On-chain needs an activated Solana account; IDR (fiat ledger) never does.
export function SendChoiceModal({
  visible,
  activated,
  onPickOnChain,
  onPickIdr,
  onClose,
}: {
  visible: boolean;
  activated: boolean;
  onPickOnChain: () => void;
  onPickIdr: () => void;
  onClose: () => void;
}) {
  return (
    <BottomSheet visible={visible} title="Send" onClose={onClose} scrimLabel="Close send options">
      <Text style={s.hint}>Choose where to send from.</Text>
      <UIButton
        title="Send On-Chain"
        note={activated ? "To Solana address" : "Activate account first"}
        icon={<ArrowUpRight size={16} color={activated ? theme.colors.foreground : theme.colors.mutedForeground} />}
        onPress={onPickOnChain}
        disabled={!activated}
      />
      <UIButton
        title="Send IDR"
        note="To xxx@pid"
        icon={<Banknote size={16} color={theme.colors.foreground} />}
        onPress={onPickIdr}
      />
      <UIButton title="Cancel" onPress={onClose} />
    </BottomSheet>
  );
}
