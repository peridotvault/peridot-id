import type { Screen } from "../hooks/useSessionBootstrap";

/**
 * Where an authenticated visit lands.
 *
 * A pending PID claim wins over everything else: the credential is verified but
 * no identity exists yet, and the ticket lives in a cookie that outlives the
 * session. Home would then render the account that was already signed in (the
 * "add account" path), so the claim screen would never appear.
 */
export function landingScreen(opts: {
  /** Auth-in-a-new-tab context must stay on login to deliver the pid_code. */
  authInNewTab: boolean;
  pendingClaim: boolean;
  /** Something read-only needs setup (fresh account, skipped onboarding). */
  needsSetup: boolean;
}): Screen {
  if (opts.authInNewTab || opts.pendingClaim) return "login";
  return opts.needsSetup ? "provisioning" : "home";
}
