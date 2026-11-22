import { AppLogo } from "./AppLogo";
import { AppOriginBadge, originHost } from "./AppOriginBadge";
import { BrandMark } from "../../../shared/components/ui/BrandMark";
import { UIButton } from "../../../shared/components/ui/UIButton";

/**
 * Terminal screen of a popup / tab sign-in, mirroring Internet Identity's
 * redirect view: app logo, the origin as a small badge (never a heading), one
 * line of state, and a Close escape hatch. `pending` animates while the code
 * is being handed back, so the pause before the redirect reads as work.
 */
export function SigningScreen({
  origin,
  appName,
  logoUrl,
  pending,
  denied,
}: {
  origin: string;
  appName?: string | null;
  logoUrl?: string | null;
  /** Code is being delivered — spin instead of showing the final "all set". */
  pending?: boolean;
  denied?: boolean;
}) {
  const heading = denied ? "Request denied" : pending ? "Signing in securely" : "You're all set";
  const host = origin ? originHost(origin) : "";
  const body = denied
    ? "Nothing was shared with the app."
    : host
      ? `Returning to ${host}. You can close this window.`
      : "Signed in. You can close this window.";

  return (
    <div className="scrim-in flex flex-1 flex-col items-center justify-center gap-3 px-6">
      <div className="relative">
        {pending ? (
          <>
            <AppLogo logoUrl={logoUrl} name={appName ?? host} />
            {/* II's redirect ring: the outline draws around the app logo, then
                breathes. 92px = the 80px tile + 6px on each side. */}
            <svg
              viewBox="0 0 92 92"
              width="92"
              height="92"
              className="absolute -inset-1.5"
              aria-hidden="true"
            >
              <rect x="1" y="1" width="90" height="90" rx="20" className="fill-none stroke-accent/20" strokeWidth="2" />
              <rect x="1" y="1" width="90" height="90" rx="20" className="sign-in-draw fill-none stroke-accent" strokeWidth="2" />
            </svg>
          </>
        ) : (
          <BrandMark size="md" />
        )}
      </div>
      {origin ? <AppOriginBadge origin={origin} /> : null}
      <h1 className="text-center font-sans text-xl font-semibold text-foreground">{heading}</h1>
      {pending ? (
        // II's redirect view credits the provider here instead of a subtitle,
        // so the app's origin badge above stays the only domain on screen.
        <span className="text-center font-sans text-sm text-muted-foreground">
          Powered by PeridotID{typeof window !== "undefined" ? ` · ${window.location.hostname}` : ""}
        </span>
      ) : (
        <p className="max-w-[280px] text-center font-sans text-sm text-paragraph">{body}</p>
      )}
      {!pending && <UIButton title="Close" className="mt-2 w-full max-w-[280px]" onPress={() => window.close()} />}
    </div>
  );
}
