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

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, "google") {
  constructor(options: GoogleOAuthOptions, private readonly authService: AuthService) {
    super({
      clientID: options.clientID,
      clientSecret: options.clientSecret,
      callbackURL: options.callbackURL,
      scope: ["profile", "email"],
    });
  }

  async validate(accessToken: string, refreshToken: string, profile: GoogleProfile, done: VerifyCallback): Promise<void> {
    try {
      const identity = await this.authService.upsertGoogleIdentity(profile);
      done(null, identity);
    } catch (err) {
      done(err as Error);
    }
  }
}

export const GOOGLE_OAUTH_OPTIONS = Symbol("GOOGLE_OAUTH_OPTIONS");

export function googleOAuthOptionsFactory(config: ConfigService): GoogleOAuthOptions | null {
  const clientID = config.get<string>("GOOGLE_CLIENT_ID", "");
  const clientSecret = config.get<string>("GOOGLE_CLIENT_SECRET", "");
  if (!clientID || !clientSecret) return null;
  return {
    clientID,
    clientSecret,
    callbackURL: config.get<string>("GOOGLE_CALLBACK_URL", "http://localhost:3000/v1/auth/google/callback"),
  };
}
