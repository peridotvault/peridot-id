import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy, VerifyCallback } from "passport-google-oauth20";
import { AuthService, GoogleProfile } from "./auth.service";

export interface GoogleOAuthOptions {
  clientID: string;
  clientSecret: string;
  callbackURL: string;
}

/** Marker for a verified Google credential with no identity yet — the claim UI takes over. */
export interface PendingGoogleClaim {
  claimProfile: GoogleProfile;
}

export function isPendingGoogleClaim(user: unknown): user is PendingGoogleClaim {
  return typeof user === "object" && user !== null && "claimProfile" in user;
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, "google") {
  constructor(options: GoogleOAuthOptions, private readonly authService: AuthService) {
    super({
      clientID: options.clientID,
      clientSecret: options.clientSecret,
      callbackURL: options.callbackURL,
      scope: ["profile", "email"],
      passReqToCallback: true,
    });
  }

  // Force the Google account chooser on every sign-in (the OAuth2 base passes the
  // per-request options to authorizationParams, not the constructor config).
  authorizationParams(): Record<string, string> {
    return { prompt: "select_account" };
  }

  async validate(req: unknown, accessToken: string, refreshToken: string, profile: GoogleProfile, done: VerifyCallback): Promise<void> {
    try {
      // Returning credential → session as usual. New credentials defer to the
      // claim screen (ClaimService) — handles are only ever chosen there.
      const identity = await this.authService.findGoogleIdentity(profile.id);
      if (identity) {
        done(null, identity);
        return;
      }
      done(null, { claimProfile: profile });
    } catch (err) {
      done(err as Error);
    }
  }
}

export const GOOGLE_OAUTH_OPTIONS = Symbol("GOOGLE_OAUTH_OPTIONS");

export function googleOAuthOptionsFactory(config: ConfigService): GoogleOAuthOptions | null {
  // Per-environment credentials: dev and prod run the IDENTICAL OAuth code path —
  // only the client (id/secret/redirect URI) differs. Unprefixed names are the legacy
  // fallback, used when the suffixed set is absent.
  const suffix = config.get<string>("NODE_ENV") === "production" ? "PROD" : "DEV";
  const pick = (base: string, fallback = ""): string =>
    config.get<string>(`${base}_${suffix}`, "") || config.get<string>(base, fallback);
  const clientID = pick("GOOGLE_CLIENT_ID");
  const clientSecret = pick("GOOGLE_CLIENT_SECRET");
  if (!clientID || !clientSecret) return null;
  return {
    clientID,
    clientSecret,
    callbackURL: pick("GOOGLE_CALLBACK_URL", "http://localhost:3301/v1/auth/google/callback"),
  };
}
