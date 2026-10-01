import { Text, View } from "react-native";
import { styles as s } from "../../shared/theme";
import { UIButton } from "../../shared/components/UIButton";

/**
 * Embedded wallet entry: shown inside the iframe before the parent hands over a
 * bearer. Sign-in itself opens the PeridotID popup on the parent's behalf (the
 * iframe can't hold the session cookie cross-site).
 */
export function EmbedConnectScreen({ onConnect }: { onConnect: () => void }) {
  return (
    <View style={s.container}>
      <Text style={s.title}>PeridotID</Text>
      <Text style={s.subtitle}>Connect your PeridotID wallet to continue in this app.</Text>
      <UIButton title="Sign in with PeridotID" onPress={onConnect} variant="primary" />
    </View>
  );
}
