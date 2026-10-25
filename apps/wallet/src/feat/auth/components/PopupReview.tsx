import { useEffect, useRef, useState } from "react";
import { Pressable } from "../../../shared/components/Pressable";
import { styles as s } from "../../../shared/theme";
import { UIButton } from "../../../shared/components/UIButton";
import type { ExecuteGate } from "../utils/knownPrograms";

export const UNKNOWN_PROGRAM_RISK_COPY =
  "This action calls a program this wallet doesn't recognize. It can move any SOL or tokens your smart account holds — including things you didn't intend to spend. Only continue if you trust the requesting app and understand exactly what this call does.";

export function PopupReview({
  summary,
  origin,
  busy,
  onApprove,
  onDeny,
  approvingPid,
  switched,
  gate,
  acknowledged,
  onAcknowledgedChange,
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
  /** Execute disclosure gate; omit for non-execute actions (unchanged flow). */
  gate?: ExecuteGate;
  /** Unknown-target acknowledgement checkbox state (controlled by the parent). */
  acknowledged?: boolean;
  onAcknowledgedChange?: (next: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  // ANT-341 FR7: flag timer cleaned up on unmount (no setState-after-unmount).
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );
  const unknown = gate?.kind === "unknown" ? gate : null;
  const invalid = gate?.kind === "invalid" ? gate : null;
  // AC3/AC6: unknown requires acknowledgement; malformed blocks Approve entirely.
  // Deny is never gated by acknowledgement (AC3) — only by the busy ceremony.
  const approveDisabled = busy || invalid != null || (unknown != null && acknowledged !== true);

  const copyTarget = () => {
    if (!unknown) return;
    const done = () => {
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    };
    try {
      const clip = (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
      if (clip?.writeText) {
        void clip.writeText(unknown.description.target).then(done, done);
        return;
      }
    } catch {
      // clipboard unavailable — selection still allows manual copy
    }
    done();
  };

  return (
    <>
      {summary && (
        <>
          <span style={s.label}>Requested action</span>
          <span style={s.mono} className="select-text">{summary}</span>
        </>
      )}
      {unknown && (
        <div style={s.card} className="flex flex-col">
          <span style={s.label}>Unknown program</span>
          <span style={s.mono} className="select-text">{unknown.description.target}</span>
          <Pressable onPress={copyTarget} accessibilityRole="button" accessibilityLabel="Copy program address">
            <span style={s.hint}>{copied ? "Copied" : "Copy address"}</span>
          </Pressable>
          <span style={s.mono}>
            {unknown.description.dataLen} bytes · sha256:{unknown.description.dataHashHex}
          </span>
          <p style={s.hint}>
            {unknown.description.metaCount} accounts ({unknown.description.writableCount} writable)
          </p>
          <p style={s.hint}>{UNKNOWN_PROGRAM_RISK_COPY}</p>
          <Pressable
            style={{ flexDirection: "row" }}
            className="items-center gap-2.5"
            onPress={() => onAcknowledgedChange?.(!(acknowledged === true))}
            disabled={busy}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: acknowledged === true }}
            accessibilityLabel="I understand this calls an unknown program"
          >
            <div className={`flex flex-col h-[22px] w-[22px] items-center justify-center border ${acknowledged === true ? "border-foreground" : "border-muted-foreground"}`}>
              {acknowledged === true && <span aria-hidden="true" className="font-sans text-sm text-foreground">✓</span>}
            </div>
            <span className="flex-1 font-sans text-xs text-muted-foreground">I understand this calls an unknown program</span>
          </Pressable>
        </div>
      )}
      {invalid && (
        <div style={s.card} className="flex flex-col">
          <p role="alert" style={s.error}>Cannot approve this request</p>
          <p style={s.hint}>{invalid.reason}</p>
        </div>
      )}
      {approvingPid && (
        <p style={s.hint}>
          Approving as {approvingPid}{switched ? " (switched to this account for approval)" : ""}
        </p>
      )}
      <p style={s.hint}>Requested by {origin}</p>
      <p style={s.hint}>Review carefully — approving signs with your passkey.</p>
      <UIButton title={busy ? "Waiting for passkey…" : "Approve"} onPress={onApprove} disabled={approveDisabled} variant="primary" />
      <UIButton title="Deny" onPress={onDeny} disabled={busy} />
    </>
  );
}
