import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import { Authority, AuthorityStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import { coseToCompressedBase64url } from "./cose";

const SECP256R1_ALG = -7; // ES256 = ECDSA P-256 (secp256r1) — owner passkey alg
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // PRD_v4 §22: challenge TTL ≤ 5 min, single use

// Structural subset of the simplewebauthn JSON types (matches the API DTO); the verification
// library receives the full-typed object at the call site.
export interface RegistrationInput {
  id: string;
  rawId: string;
  response: { clientDataJSON: string; attestationObject: string };
  clientExtensionResults?: Record<string, unknown>;
  type?: string;
}

export interface AuthenticationInput {
  id: string;
  rawId: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
  clientExtensionResults?: Record<string, unknown>;
  type?: string;
}

export interface AuthorityView {
  id: string;
  type: string;
  credentialId: string | null;
  /** 33-byte compressed secp256r1 public key, base64url — the on-chain authority (task 004). */
  publicKey: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface RegisterStartResult {
  registrationId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
  isAdditional: boolean;
  approval: PublicKeyCredentialRequestOptionsJSON | null;
}

export interface AuthenticateStartResult {
  authenticationId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}

function toView(a: Authority): AuthorityView {
  return {
    id: a.id,
    type: a.type,
    credentialId: a.credentialId,
    publicKey: coseToCompressedBase64url(Buffer.from(a.publicKey)),
    createdAt: a.createdAt,
    lastUsedAt: a.lastUsedAt,
  };
}

function toWebAuthnCredential(a: Authority): WebAuthnCredential {
  return { id: a.credentialId!, publicKey: new Uint8Array(a.publicKey), counter: 0 };
}

function toAllowCredential(a: { credentialId: string | null }) {
  return { id: a.credentialId!, type: "public-key" as const };
}

@Injectable()
export class CredentialService {
  private readonly logger = new Logger(CredentialService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly security: SecurityEventService,
  ) {}

  private rpId(): string {
    return this.config.get<string>("WEBAUTHN_RP_ID") ?? "localhost";
  }

  private origins(): string[] {
    const raw = this.config.get<string>("WEBAUTHN_ORIGINS") ?? "http://localhost:3301,http://localhost:5173";
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }

  private rpName(): string {
    return this.config.get<string>("WEBAUTHN_RP_NAME") ?? "PeridotID";
  }

  /**
   * The token identity, verified active. 1 identity = 1 personal
   * wallet, so the pid itself is the wallet scope.
   */
  private async resolveAccount(pid: string): Promise<string> {
    const identity = await this.prisma.identity.findUnique({ where: { pid }, select: { status: true } });
    if (!identity || identity.status !== "active") throw new NotFoundException("Account not found");
    return pid;
  }

  private async activeAuthorities(pid: string): Promise<Authority[]> {
    return this.prisma.authority.findMany({ where: { pid, status: "active" } });
  }

  private async consumeChallenge(id: string, pid: string): Promise<{ challenge: string; approvalChallenge: string | null; isAdditional: boolean }> {
    const pending = await this.prisma.credentialChallenge.findFirst({ where: { id, consumedAt: null } });
    if (!pending || !pending.pid) throw new BadRequestException("Challenge not found or already used");
    if (pending.expiresAt < new Date()) throw new BadRequestException("Tantangan sudah kedaluwarsa");

    if (pending.pid !== pid) throw new NotFoundException("Account not found");

    await this.prisma.credentialChallenge.update({ where: { id }, data: { consumedAt: new Date() } });
    return { challenge: pending.challenge, approvalChallenge: pending.approvalChallenge, isAdditional: pending.isAdditional };
  }

  /** Consume an unauthenticated passkey-login challenge (no identity/account scope). */
  private async consumeLoginChallenge(id: string): Promise<{ challenge: string }> {
    const pending = await this.prisma.credentialChallenge.findFirst({ where: { id, consumedAt: null, kind: "login" } });
    if (!pending) throw new BadRequestException("Challenge not found or already used");
    if (pending.expiresAt < new Date()) throw new BadRequestException("Tantangan sudah kedaluwarsa");
    await this.prisma.credentialChallenge.update({ where: { id }, data: { consumedAt: new Date() } });
    return { challenge: pending.challenge };
  }

  async list(pid: string): Promise<AuthorityView[]> {
    await this.resolveAccount(pid);
    return (await this.activeAuthorities(pid)).map(toView);
  }

  async registerStart(pid: string): Promise<RegisterStartResult> {
    await this.resolveAccount(pid);
    const authorities = await this.activeAuthorities(pid);
    const isAdditional = authorities.length > 0;
    // Passkey labels: the OS account sheet lists by user.name/displayName, so
    // show the permanent PID (plus mutable displayName when set) — never an
    // opaque ID. Multiple PIDs on one device stay distinguishable.
    const profile = await this.prisma.profile.findUnique({ where: { pid } });

    const options = await generateRegistrationOptions({
      rpName: this.rpName(),
      rpID: this.rpId(),
      userID: createHash("sha256").update(pid).digest(),
      userName: pid,
      userDisplayName: profile?.displayName ?? pid,
      attestationType: "none",
      supportedAlgorithmIDs: [SECP256R1_ALG],
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
        // First passkey stays on the platform authenticator (device). Additional passkeys may
        // enroll on a roaming authenticator / security key so users can add cross-device
        // recovery without hitting the device's one-passkey-per-site limit (InvalidStateError).
        ...(isAdditional ? {} : { authenticatorAttachment: "platform" }),
      },
      excludeCredentials: authorities.map(toAllowCredential),
    });

    let approval = null;
    if (isAdditional) {
      // Existing-credential approval rule: adding a credential requires approval by an existing valid credential.
      approval = await generateAuthenticationOptions({
        rpID: this.rpId(),
        challenge: randomBytes(32),
        userVerification: "required",
        allowCredentials: authorities.map(toAllowCredential),
      });
    }

    const pending = await this.prisma.credentialChallenge.create({
      data: {
        pid,
        kind: "registration",
        challenge: options.challenge,
        approvalChallenge: approval?.challenge ?? null,
        isAdditional,
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      },
    });

    return { registrationId: pending.id, options, isAdditional, approval };
  }

  async registerFinish(pid: string, dto: {
    registrationId: string;
    credential: RegistrationInput;
    approval?: AuthenticationInput;
  }): Promise<AuthorityView> {
    await this.resolveAccount(pid);
    const pending = await this.consumeChallenge(dto.registrationId, pid);

    const existing = await this.prisma.authority.findFirst({
      where: { credentialId: dto.credential.id },
    });
    if (existing) {
      await this.security.log(pid, "credential.register.rejected", { reason: "credential_id_exists" });
      throw new BadRequestException("Credential already registered");
    }

    if (pending.isAdditional) {
      if (!dto.approval || !pending.approvalChallenge) {
        await this.security.log(pid, "credential.register.rejected", { reason: "missing_approval" });
        throw new BadRequestException("Existing credential approval required");
      }
      // The approving credential must be one of this account's active authorities.
      const approver = await this.prisma.authority.findFirst({
        where: { pid, credentialId: dto.approval.id, status: "active" },
      });
      if (!approver) {
        await this.security.log(pid, "credential.register.rejected", { reason: "unknown_approver" });
        throw new BadRequestException("Approval credential is invalid");
      }
      try {
        await verifyAuthenticationResponse({
          response: dto.approval as AuthenticationResponseJSON,
          expectedChallenge: pending.approvalChallenge,
          expectedOrigin: this.origins(),
          expectedRPID: this.rpId(),
          credential: toWebAuthnCredential(approver),
        });
      } catch (err) {
        const reason = (err as Error).message;
        await this.security.log(pid, "credential.register.rejected", { reason: "approval_verification_failed", detail: reason });
        this.logger.warn(`passkey approval verification failed: ${reason}`);
        throw new BadRequestException("Credential approval failed verification");
      }
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: dto.credential as RegistrationResponseJSON,
        expectedChallenge: pending.challenge,
        expectedOrigin: this.origins(),
        expectedRPID: this.rpId(),
        requireUserVerification: true,
        supportedAlgorithmIDs: [SECP256R1_ALG],
      });
    } catch (err) {
      const reason = (err as Error).message;
      await this.security.log(pid, "credential.register.rejected", { reason: "registration_verification_failed", detail: reason });
      this.logger.warn(`passkey registration verification failed: ${reason}`);
      throw new BadRequestException("Registration failed verification");
    }
    if (!verification.verified || !verification.registrationInfo) {
      await this.security.log(pid, "credential.register.rejected", { reason: "not_verified" });
      throw new BadRequestException("Registration not verified");
    }

    const authority = await this.prisma.authority.create({
      data: {
        pid,
        type: "secp256r1",
        publicKey: Buffer.from(verification.registrationInfo.credential.publicKey),
        credentialId: dto.credential.id,
      },
    });

    await this.security.log(pid, "credential.registered", { credentialId: authority.credentialId });
    return toView(authority);
  }

  async authenticateStart(pid: string): Promise<AuthenticateStartResult> {
    await this.resolveAccount(pid);
    const authorities = await this.activeAuthorities(pid);
    if (authorities.length === 0) throw new BadRequestException("No registered credentials");

    const options = await generateAuthenticationOptions({
      rpID: this.rpId(),
      userVerification: "required",
      allowCredentials: authorities.map(toAllowCredential),
    });

    const pending = await this.prisma.credentialChallenge.create({
      data: {
        pid,
        kind: "authentication",
        challenge: options.challenge,
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      },
    });

    return { authenticationId: pending.id, options };
  }

  async authenticateFinish(pid: string, dto: {
    authenticationId: string;
    credential: AuthenticationInput;
  }): Promise<{ ok: true }> {
    await this.resolveAccount(pid);
    const pending = await this.consumeChallenge(dto.authenticationId, pid);

    const authority = await this.prisma.authority.findFirst({
      where: { pid, credentialId: dto.credential.id, status: "active" },
    });
    if (!authority) {
      await this.security.log(pid, "credential.authenticate.rejected", { reason: "unknown_credential" });
      throw new BadRequestException("Unknown credential");
    }

    try {
      await verifyAuthenticationResponse({
        response: dto.credential as AuthenticationResponseJSON,
        expectedChallenge: pending.challenge,
        expectedOrigin: this.origins(),
        expectedRPID: this.rpId(),
        credential: toWebAuthnCredential(authority),
      });
    } catch (err) {
      const reason = (err as Error).message;
      await this.security.log(pid, "credential.authenticate.rejected", { reason: "verification_failed", detail: reason });
      this.logger.warn(`passkey authentication verification failed: ${reason}`);
      throw new BadRequestException("Authentication failed verification");
    }

    await this.prisma.authority.update({ where: { id: authority.id }, data: { lastUsedAt: new Date() } });
    await this.security.log(pid, "credential.authenticated", { credentialId: authority.credentialId });
    return { ok: true };
  }

  /**
   * Passkey sign-in (discoverable credentials, no allowCredentials). Unauthenticated —
   * the challenge is stored outside any account so a fresh visitor can log in.
   */
  async loginStart(): Promise<AuthenticateStartResult> {
    const options = await generateAuthenticationOptions({
      rpID: this.rpId(),
      userVerification: "required",
    });
    const pending = await this.prisma.credentialChallenge.create({
      data: {
        kind: "login",
        challenge: options.challenge,
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      },
    });
    return { authenticationId: pending.id, options };
  }

  /** Verify a passkey-login assertion and return the identity it belongs to. */
  async loginFinish(dto: { authenticationId: string; credential: AuthenticationInput }): Promise<{ pid: string }> {
    const pending = await this.consumeLoginChallenge(dto.authenticationId);

    const authority = await this.prisma.authority.findFirst({
      where: { credentialId: dto.credential.id, status: "active" },
    });
    if (!authority) {
      throw new BadRequestException("Unknown credential");
    }

    const userHandle = dto.credential.response.userHandle;
    const expectedHandle = Buffer.from(createHash("sha256").update(authority.pid).digest()).toString("base64url");
    if (userHandle && userHandle !== expectedHandle) {
      await this.security.log(authority.pid, "credential.login.rejected", { reason: "user_handle_mismatch" });
      throw new BadRequestException("Credential does not match this account");
    }

    try {
      await verifyAuthenticationResponse({
        response: dto.credential as AuthenticationResponseJSON,
        expectedChallenge: pending.challenge,
        expectedOrigin: this.origins(),
        expectedRPID: this.rpId(),
        credential: toWebAuthnCredential(authority),
      });
    } catch {
      await this.security.log(authority.pid, "credential.login.rejected", { reason: "verification_failed" });
      throw new BadRequestException("Authentication failed verification");
    }

    await this.prisma.authority.update({ where: { id: authority.id }, data: { lastUsedAt: new Date() } });
    await this.security.log(authority.pid, "credential.login.succeeded", { credentialId: authority.credentialId });
    return { pid: authority.pid };
  }

  async revoke(pid: string, authorityId: string): Promise<AuthorityView> {
    await this.resolveAccount(pid);
    const authority = await this.prisma.authority.findFirst({
      where: { id: authorityId, pid },
    });
    if (!authority) throw new NotFoundException("Credential not found");

    const activeCount = await this.prisma.authority.count({ where: { pid, status: "active" } });
    // Last-credential guard: the account must keep ≥1 valid authority (mirrors identity guard).
    if (activeCount <= 1) throw new BadRequestException("The last credential cannot be revoked");

    const updated = await this.prisma.authority.update({
      where: { id: authority.id },
      data: { status: "revoked" as AuthorityStatus },
    });
    await this.security.log(pid, "credential.revoked", { credentialId: authority.credentialId });
    return toView(updated);
  }
}