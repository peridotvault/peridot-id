import { BrandMark } from "../../../shared/components/ui/BrandMark";
import { AppLogo } from "./AppLogo";
import { AppOriginBadge, originHost } from "./AppOriginBadge";

/** PeridotID's own line when the app has no owner-set tagline. */
export const APP_TAGLINE_FALLBACK =
  "One identity for gaming: wallet, items and Rupiah. Private and tamperproof.";

// "Who is asking" block shared by every auth screen (sign-in options, consent,
// approval, email code, PID claim): app logo + origin badge + tagline, then the
// screen's own title. One component, so a dapp sees the same header whether it
// hits the login tab or the approval popup. No origin = PeridotID's own screen.
export function AppIdentity({
  origin,
  appName,
  logoUrl,
  description,
  verified,
  title,
  subtitle,
}: {
  origin?: string | null;
  appName?: string | null;
  logoUrl?: string | null;
  description?: string | null;
  verified?: boolean;
  /** The screen's h1 (exactly one per screen). */
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      {origin ? (
        <AppLogo logoUrl={logoUrl} name={appName ?? originHost(origin)} />
      ) : (
        <BrandMark size="lg" />
      )}
      {/* The origin is the small badge the user verifies — never the heading,
          so a long domain can't blow the card up. */}
      {origin ? <AppOriginBadge origin={origin} /> : null}
      <p className="line-clamp-2 max-w-[280px] text-center font-sans text-sm text-paragraph">
        {description || APP_TAGLINE_FALLBACK}
      </p>
      <h1 className="self-start text-left font-sans text-xl font-semibold text-foreground">{title}</h1>
      {subtitle ? (
        <span className="self-start text-left font-sans text-sm text-paragraph">{subtitle}</span>
      ) : null}
      {verified ? (
        <span className="text-center font-sans text-xs text-success">
          <span aria-hidden="true">✓ </span>Verified partner — 0% PeridotID fee
        </span>
      ) : null}
    </div>
  );
}
