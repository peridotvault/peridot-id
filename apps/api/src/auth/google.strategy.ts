import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy, VerifyCallback } from "passport-google-oauth20";
import { AuthService, GoogleProfile } from "./auth.service";
import { decodeState } from "./sso.service";

export interface GoogleOAuthOptions {
  clientID: string;
  clientSecret: string;
  callbackURL: string;
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
      // The user-chosen PID handle round-trips through OAuth `state` (see GoogleGuard).
      let handle: string | undefined;
      try {
        const state = (req as { query?: { state?: unknown } })?.query?.state;
        if (typeof state === "string") handle = decodeState(state).handle;
      } catch {
        handle = undefined;
      }
      const identity = await this.authService.upsertGoogleIdentity(profile, handle);
      done(null, identity);
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
