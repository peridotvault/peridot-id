import { IsObject, IsOptional, IsString } from "class-validator";

// Mirrors @simplewebauthn/typescript-types' RegistrationResponseJSON /
// AuthenticationResponseJSON — the WebAuthn verification library enforces the crypto, this
// just shapes the envelope.
export class RegistrationResponseDto {
  @IsString()
  id!: string;

  @IsString()
  rawId!: string;

  @IsObject()
  response!: {
    clientDataJSON: string;
    attestationObject: string;
  };

  @IsOptional()
  @IsObject()
  clientExtensionResults?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  type?: string;
}

export class AuthenticationResponseDto {
  @IsString()
  id!: string;

  @IsString()
  rawId!: string;

  @IsObject()
  response!: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };

  @IsOptional()
  @IsObject()
  clientExtensionResults?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  type?: string;
}

export class RegisterFinishDto {
  @IsString()
  registrationId!: string;

  @IsObject()
  credential!: RegistrationResponseDto;

  /** Existing-credential assertion — required when the account already has an authority. */
  @IsOptional()
  @IsObject()
  approval?: AuthenticationResponseDto;
}

export class AuthenticateFinishDto {
  @IsString()
  authenticationId!: string;

  @IsObject()
  credential!: AuthenticationResponseDto;

  /** Cross-domain success origin to return to with a pid_code (allowlisted). */
  @IsOptional()
  @IsString()
  returnTo?: string;

  /** Registered third-party app this login is for (binds the pid_code to the app). */
  @IsOptional()
  @IsString()
  clientId?: string;
}