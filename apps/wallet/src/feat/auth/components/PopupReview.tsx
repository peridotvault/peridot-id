import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable } from "../../../shared/components/ui/Pressable";
import { UIButton } from "../../../shared/components/ui/UIButton";
import { AppIdentity } from "./AppIdentity";
import type { ExecuteGate } from "../utils/knownPrograms";

export const UNKNOWN_PROGRAM_RISK_COPY =
  "This action calls a program this wallet doesn't recognize. It can move any SOL or tokens your smart account holds — including things you didn't intend to spend. Only continue if you trust the requesting app and understand exactly what this call does.";

// Card body of an approval (the shell lives in the page, `ConsentShell`): who is
// asking, what it asks for, the risk block when the call is unknown, and the two
// actions. Same proportions as the login consent card so a dapp request is not a
// second, older-looking product.
export function PopupReview({
  summary,
  origin,
  appName,
  logoUrl,
  description,
  verified,
  details,
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
  /** Registered app name; falls back to the origin's host. */
  appName?: string | null;
  /** Owner-set logo; null renders the generic tile. */
  logoUrl?: string | null;
  /** Owner-set tagline; null falls back to PeridotID's own line. */
  description?: string | null;
  /** Verified partner: PeridotID fee waived for this app (trust signal). */
  verified?: boolean;
  /** Verified quote/breakdown rendered above the action (fiat checkout). */
  details?: ReactNode;
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
  // Payloads (execute data, fiat summary) outgrow the card: clamp the preview and
  // keep the full text one tap away.
  const longSummary = summary != null && summary.length > 160;

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
      <AppIdentity
        origin={origin}
        appName={appName}
        logoUrl={logoUrl}
        description={description}
        verified={verified}
        title={appName ? `Approve for ${appName}` : "Approve this request"}
        subtitle="with your PeridotID"
      />

      {details}

      {summary && (
        <div className="flex flex-col gap-1 border-t border-line pt-3">
          <span className="font-sans text-xs font-medium text-muted-foreground">Requested action</span>
          <p className="line-clamp-3 select-text break-words font-mono text-xs text-paragraph">{summary}</p>
          {longSummary && (
            <details className="flex flex-col">
              <summary className="cursor-pointer font-sans text-xs text-muted-foreground">Show full request</summary>
              <p className="mt-1 max-h-40 select-text overflow-y-auto break-all font-mono text-xs text-paragraph">
                {summary}
              </p>
            </details>
          )}
        </div>
      )}

      {unknown && (
        <div className="flex flex-col gap-1 border-t border-line pt-3">
          <span className="font-sans text-xs font-medium text-muted-foreground">Unknown program</span>
          <span className="select-text break-all font-mono text-xs text-paragraph">{unknown.description.target}</span>
          <Pressable onPress={copyTarget} accessibilityRole="button" accessibilityLabel="Copy program address">
            <span className="text-xs text-muted-foreground">{copied ? "Copied" : "Copy address"}</span>
          </Pressable>
          <span className="break-all font-mono text-xs text-paragraph">
            {unknown.description.dataLen} bytes · sha256:{unknown.description.dataHashHex}
          </span>
          <p className="font-sans text-xs text-muted-foreground">
            {unknown.description.metaCount} accounts ({unknown.description.writableCount} writable)
          </p>
          <p className="font-sans text-xs text-paragraph">{UNKNOWN_PROGRAM_RISK_COPY}</p>
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
        <div role="alert" className="flex flex-col gap-1 border-t border-line pt-3">
          <p className="text-sm text-danger">Cannot approve this request</p>
          <p className="font-sans text-xs text-paragraph">{invalid.reason}</p>
        </div>
      )}

      <div className="flex flex-col mt-1 gap-3">
        {approvingPid && (
          <span className="self-start rounded-md border border-line px-2 py-1 font-mono text-xs text-paragraph">
            {approvingPid}
            {switched ? " · signing as this account" : ""}
          </span>
        )}
        <p className="font-sans text-xs text-muted-foreground">Review carefully — approving signs with your passkey.</p>
        <UIButton title={busy ? "Waiting for passkey…" : "Approve"} onPress={onApprove} disabled={approveDisabled} variant="primary" />
        <div className="flex items-center justify-center">
          <Pressable onPress={onDeny} disabled={busy} accessibilityRole="button" accessibilityLabel="Deny request">
            <span className="font-sans text-sm text-danger">Deny</span>
          </Pressable>
        </div>
      </div>
    </>
  );
}
