import { BrandMark } from "../../../shared/components/ui/BrandMark";
import { AppLogo } from "./AppLogo";
import { AuthHeading } from "./AuthHeading";
import { originHost } from "./AppOriginBadge";

/** PeridotID's own line when the app has no owner-set tagline. */
export const APP_TAGLINE_FALLBACK =
  "One identity for gaming: wallet, items and Rupiah. Private and tamperproof.";

// App card header: the app's logo + tagline above the usual heading
// (`AuthHeading`). Used by the two cards that introduce an app — consent and
// approval. The identity steps (sign-in, code, claim) skip this and render
// `AuthHeading` alone, because the brand is already in the topbar.
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
      <p className="line-clamp-2 max-w-[280px] text-center font-sans text-sm text-paragraph">
        {description || APP_TAGLINE_FALLBACK}
      </p>
      <AuthHeading origin={origin} title={title} subtitle={subtitle} verified={verified} />
    </div>
  );
}
