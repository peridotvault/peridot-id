import { Text } from "../../../shared/primitives";
import { styles as s } from "../../../shared/theme";
import { UIButton } from "../../../shared/components/UIButton";

export function PopupReview({
  summary,
  origin,
  busy,
  onApprove,
  onDeny,
  approvingPid,
  switched,
}: {
  summary: string | null;
  origin: string;
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
  /** The pid that will sign on Approve (null while unknown). */
  approvingPid?: string | null;
  /** True when the popup switched to that pid just for this approval. */
  switched?: boolean;
}) {
  return (
    <>
      {summary && (
        <>
          <Text style={s.label}>Requested action</Text>
          <Text selectable style={s.mono}>{summary}</Text>
        </>
      )}
      {approvingPid && (
        <Text style={s.hint}>
          Approving as {approvingPid}{switched ? " (switched to this account for approval)" : ""}
        </Text>
      )}
      <Text style={s.hint}>Requested by {origin}</Text>
      <Text style={s.hint}>Review carefully — approving signs with your passkey.</Text>
      <UIButton title={busy ? "Waiting for passkey…" : "Approve"} onPress={onApprove} disabled={busy} variant="primary" />
      <UIButton title="Deny" onPress={onDeny} disabled={busy} />
    </>
  );
}
