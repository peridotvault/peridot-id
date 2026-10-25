
import { styles as s } from "../shared/theme";
import { UIButton } from "../shared/components/UIButton";

/**
 * Embedded wallet entry: shown inside the iframe before the parent hands over a
 * bearer. Sign-in itself opens the PeridotID popup on the parent's behalf (the
 * iframe can't hold the session cookie cross-site).
 */
export function EmbedConnectScreen({ onConnect }: { onConnect: () => void }) {
  return (
    <div style={s.container} className="flex flex-col">
      <h1 style={s.title}>PeridotID</h1>
      <p style={s.subtitle}>Connect your PeridotID wallet to continue in this app.</p>
      <UIButton title="Sign in with PeridotID" onPress={onConnect} variant="primary" />
    </div>
  );
}
