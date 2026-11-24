import { Pressable } from "../../../shared/components/ui/Pressable";
import { TextField } from "../../../shared/components/ui/TextField";
import { AsciiRidges } from "../../../shared/components/ui/AsciiRidges";
import { UIButton } from "../../../shared/components/ui/UIButton";
import type { HandleStatus } from "../types/login";
import { AuthHeading } from "./AuthHeading";
import { ConsentShell } from "./ConsentShell";

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
  origin,
  verified,
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
  origin?: string | null;
  verified?: boolean;
  onHandle: (t: string) => void;
  onAck: () => void;
  onSubmit: () => void;
  onSignOut: () => void;
}) {
  return (
    <div className="isolate flex flex-col flex-1 relative">
      <AsciiRidges exposure={0.6} gain={3} elementSize={14} opacity={1} layers={8} detail={3} />
      <ConsentShell seamless>
        <AuthHeading
          origin={origin}
          title="Create your PID"
          subtitle={email || displayName ? `Continuing as ${displayName ?? email}` : undefined}
          verified={verified}
        />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex flex-col w-full gap-3">
          <div className="flex flex-col relative flex-1 justify-center">
            <TextField
                id="pid-claim-handle"
                aria-label="Choose your handle"
              className="pr-16 [--placeholder:var(--color-muted-foreground)] outline-none"
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
          {handleStatus === "taken" && <p role="alert" className="text-sm text-danger">Taken — try another handle.</p>}
          {handleStatus === "invalid" && handle.length > 0 && (
            <p role="alert" className="text-sm text-danger">3-20 chars: lowercase letters, numbers, underscore.</p>
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
          <Pressable onPress={onSignOut} disabled={busy} accessibilityLabel="Sign out and cancel PID creation">
            <span className="text-center font-sans text-sm text-danger">Sign out</span>
          </Pressable>
        </div>
      </ConsentShell>
    </div>
  );
}
