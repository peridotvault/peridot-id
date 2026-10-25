import { Pressable } from "../../../shared/components/ui/Pressable";
import { TextField } from "../../../shared/components/ui/TextField";
import { styles as s } from "../../../shared/styles/theme";
import { AsciiRidges } from "../../../shared/components/ui/AsciiRidges";
import { UIButton } from "../../../shared/components/ui/UIButton";
import type { HandleStatus } from "../hooks/usePidClaim";

// Claim branch: verified credential, no identity yet — the only way forward
// is creating the permanent <handle>@pid.
export function PidClaimForm({
  email,
  displayName,
  handle,
  handleStatus,
  ackPermanent,
  busy,
  error,
  onHandle,
  onAck,
  onSubmit,
  onSignOut,
}: {
  email: string | null;
  displayName: string | null;
  handle: string;
  handleStatus: HandleStatus;
  ackPermanent: boolean;
  busy: boolean;
  error: string | null;
  onHandle: (t: string) => void;
  onAck: () => void;
  onSubmit: () => void;
  onSignOut: () => void;
}) {
  return (
    <div className="flex flex-col flex-1">
      <AsciiRidges exposure={0.6} gain={3} elementSize={14} opacity={1} layers={8} detail={3} />
      <div style={s.container} className="flex flex-col">
      <div style={{ flexDirection: "row" }} className="flex flex-col w-full items-center justify-end pt-2">
        <Pressable onPress={onSignOut} disabled={busy} accessibilityLabel="Sign out and cancel PID creation">
          <span className="font-sans text-sm text-danger">Sign Out</span>
        </Pressable>
      </div>
      <div className="flex flex-col flex-1 w-full items-center justify-center gap-5">
        <div className="flex flex-col items-center gap-2">
          <span className="font-serif text-4xl tracking-[-0.4px] text-foreground">Create your PID</span>
          {(email || displayName) && (
            <span className="font-sans text-sm text-muted-foreground">Continuing as {displayName ?? email}</span>
          )}
        </div>
        {error && <p role="alert" style={s.error}>{error}</p>}
        <div className="flex flex-col w-full max-w-[343px] gap-3">
          <div className="flex flex-col relative flex-1 justify-center">
            <TextField
                id="pid-claim-handle"
                aria-label="Choose your handle"
              style={[s.input, { paddingRight: 64 }]}
              className="[--placeholder:var(--color-muted-foreground)] outline-none"
              value={handle}
              onChangeText={onHandle}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="username"
              editable={!busy}
             />
            <span className="pointer-events-none absolute right-3 font-sans text-base text-muted-foreground">@pid</span>
          </div>
          {handleStatus === "free" && <span className="font-sans text-xs text-success"><span aria-hidden="true">✓ </span>{handle.trim().toLowerCase()}@pid is available</span>}
          {handleStatus === "taken" && <p role="alert" style={s.error}>Taken — try another handle.</p>}
          {handleStatus === "invalid" && handle.length > 0 && (
            <p role="alert" style={s.error}>3-20 chars: lowercase letters, numbers, underscore.</p>
          )}
          <Pressable
            style={{ flexDirection: "row" }}
            className="items-center gap-2.5"
            onPress={onAck}
            disabled={busy}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: ackPermanent }}
          >
            <div className={`flex flex-col h-[22px] w-[22px] items-center justify-center border ${ackPermanent ? "border-foreground" : "border-muted-foreground"}`}>
              {ackPermanent && <span aria-hidden="true" className="font-sans text-sm text-foreground">✓</span>}
            </div>
            <span className="flex-1 font-sans text-xs text-muted-foreground">
              Your PID is permanent — it can never be changed, reused, or reassigned. Choose carefully.
            </span>
          </Pressable>
          <UIButton
            title={busy ? "Creating…" : "Create & Continue"}
            onPress={onSubmit}
            disabled={busy || handleStatus !== "free" || !ackPermanent}
            variant="primary"
          />
        </div>
      </div>
      </div>
    </div>
  );
}
