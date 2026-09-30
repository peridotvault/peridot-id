import { Text } from "react-native";
import { styles as s } from "../../../shared/theme";
import { UIButton } from "../../../shared/components/UIButton";

export function PopupReview({
  summary,
  origin,
  busy,
  onApprove,
  onDeny,
}: {
  summary: string | null;
  origin: string;
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <>
      {summary && (
        <>
          <Text style={s.label}>Requested action</Text>
          <Text selectable style={s.mono}>{summary}</Text>
        </>
      )}
      <Text style={s.hint}>Requested by {origin}</Text>
      <Text style={s.hint}>Review carefully — approving signs with your passkey.</Text>
      <UIButton title={busy ? "Waiting for passkey…" : "Approve"} onPress={onApprove} disabled={busy} variant="primary" />
      <UIButton title="Deny" onPress={onDeny} disabled={busy} />
    </>
  );
}
