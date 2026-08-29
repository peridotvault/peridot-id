import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
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
import { Authority, AuthorityStatus, PeridotAccount } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import { coseToCompressedBase64url } from "./cose";

const SECP256R1_ALG = -7; // ES256 = ECDSA P-256 (secp256r1) — ADR 005 Option B
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

@Injectable()
export class CredentialService {
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

  private async resolveAccount(identityId: string): Promise<PeridotAccount> {
    const account = await this.prisma.peridotAccount.findFirst({ where: { identityId, status: "active" } });
    if (!account) throw new NotFoundException("Akun tidak ditemukan");
    return account;
  }

  private async activeAuthorities(accountId: string): Promise<Authority[]> {
    return this.prisma.authority.findMany({ where: { accountId, status: "active" } });
  }

  private async consumeChallenge(id: string, identityId: string): Promise<{ challenge: string; approvalChallenge: string | null; isAdditional: boolean }> {
    const pending = await this.prisma.credentialChallenge.findFirst({ where: { id, consumedAt: null } });
    if (!pending) throw new BadRequestException("Tantangan tidak ditemukan atau sudah dipakai");
    if (pending.expiresAt < new Date()) throw new BadRequestException("Tantangan sudah kedaluwarsa");

    const account = await this.prisma.peridotAccount.findFirst({ where: { id: pending.accountId, identityId, status: "active" } });
    if (!account) throw new NotFoundException("Akun tidak ditemukan");

    await this.prisma.credentialChallenge.update({ where: { id }, data: { consumedAt: new Date() } });
    return { challenge: pending.challenge, approvalChallenge: pending.approvalChallenge, isAdditional: pending.isAdditional };
  }

  async list(identityId: string): Promise<AuthorityView[]> {
    const account = await this.resolveAccount(identityId);
    return (await this.activeAuthorities(account.id)).map(toView);
  }

  async registerStart(identityId: string): Promise<RegisterStartResult> {
    const account = await this.resolveAccount(identityId);
    const authorities = await this.activeAuthorities(account.id);
    const isAdditional = authorities.length > 0;

    const options = await generateRegistrationOptions({
      rpName: this.rpName(),
      rpID: this.rpId(),
      userID: createHash("sha256").update(identityId).digest(),
      userName: identityId,
      userDisplayName: identityId,
      attestationType: "none",
      supportedAlgorithmIDs: [SECP256R1_ALG],
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
        authenticatorAttachment: "platform",
      },
      excludeCredentials: authorities.map((a) => ({ id: a.credentialId!, type: "public-key" })),
    });

    let approval = null;
    if (isAdditional) {
      // ADR 006 §4: adding a credential requires approval by an existing valid credential.
      approval = await generateAuthenticationOptions({
        rpID: this.rpId(),
        challenge: randomBytes(32),
        userVerification: "required",
        allowCredentials: authorities.map((a) => ({ id: a.credentialId!, type: "public-key" })),
      });
    }

    const pending = await this.prisma.credentialChallenge.create({
      data: {
        accountId: account.id,
        kind: "registration",
        challenge: options.challenge,
        approvalChallenge: approval?.challenge ?? null,
        isAdditional,
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      },
    });

    return { registrationId: pending.id, options, isAdditional, approval };
  }

  async registerFinish(identityId: string, dto: {
    registrationId: string;
    credential: RegistrationInput;
    approval?: AuthenticationInput;
  }): Promise<AuthorityView> {
    const account = await this.resolveAccount(identityId);
    const pending = await this.consumeChallenge(dto.registrationId, identityId);

    const existing = await this.prisma.authority.findFirst({
      where: { credentialId: dto.credential.id },
    });
    if (existing) {
      await this.security.log(identityId, "credential.register.rejected", { reason: "credential_id_exists" }, account.id);
      throw new BadRequestException("Kredensial sudah terdaftar");
    }

    if (pending.isAdditional) {
      if (!dto.approval || !pending.approvalChallenge) {
        await this.security.log(identityId, "credential.register.rejected", { reason: "missing_approval" }, account.id);
        throw new BadRequestException("Persetujuan kredensial yang ada diperlukan");
      }
      // The approving credential must be one of this account's active authorities.
      const approver = await this.prisma.authority.findFirst({
        where: { accountId: account.id, credentialId: dto.approval.id, status: "active" },
      });
      if (!approver) {
        await this.security.log(identityId, "credential.register.rejected", { reason: "unknown_approver" }, account.id);
        throw new BadRequestException("Kredensial persetujuan tidak valid");
      }
      try {
        await verifyAuthenticationResponse({
          response: dto.approval as AuthenticationResponseJSON,
          expectedChallenge: pending.approvalChallenge,
          expectedOrigin: this.origins(),
          expectedRPID: this.rpId(),
          credential: toWebAuthnCredential(approver),
        });
      } catch {
        await this.security.log(identityId, "credential.register.rejected", { reason: "approval_verification_failed" }, account.id);
        throw new BadRequestException("Persetujuan kredensial gagal diverifikasi");
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
    } catch {
      await this.security.log(identityId, "credential.register.rejected", { reason: "registration_verification_failed" }, account.id);
      throw new BadRequestException("Registrasi gagal diverifikasi");
    }
    if (!verification.verified || !verification.registrationInfo) {
      await this.security.log(identityId, "credential.register.rejected", { reason: "not_verified" }, account.id);
      throw new BadRequestException("Registrasi tidak terverifikasi");
    }

    const authority = await this.prisma.authority.create({
      data: {
        accountId: account.id,
        type: "secp256r1",
        publicKey: Buffer.from(verification.registrationInfo.credential.publicKey),
        credentialId: dto.credential.id,
      },
    });

    await this.security.log(identityId, "credential.registered", { credentialId: authority.credentialId }, account.id);
    return toView(authority);
  }

  async authenticateStart(identityId: string): Promise<AuthenticateStartResult> {
    const account = await this.resolveAccount(identityId);
    const authorities = await this.activeAuthorities(account.id);
    if (authorities.length === 0) throw new BadRequestException("Tidak ada kredensial terdaftar");

    const options = await generateAuthenticationOptions({
      rpID: this.rpId(),
      userVerification: "required",
      allowCredentials: authorities.map((a) => ({ id: a.credentialId!, type: "public-key" })),
    });

    const pending = await this.prisma.credentialChallenge.create({
      data: {
        accountId: account.id,
        kind: "authentication",
        challenge: options.challenge,
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      },
    });

    return { authenticationId: pending.id, options };
  }

  async authenticateFinish(identityId: string, dto: {
    authenticationId: string;
    credential: AuthenticationInput;
  }): Promise<{ ok: true }> {
    const account = await this.resolveAccount(identityId);
    const pending = await this.consumeChallenge(dto.authenticationId, identityId);

    const authority = await this.prisma.authority.findFirst({
      where: { accountId: account.id, credentialId: dto.credential.id, status: "active" },
    });
    if (!authority) {
      await this.security.log(identityId, "credential.authenticate.rejected", { reason: "unknown_credential" }, account.id);
      throw new BadRequestException("Kredensial tidak dikenal");
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
      await this.security.log(identityId, "credential.authenticate.rejected", { reason: "verification_failed" }, account.id);
      throw new BadRequestException("Autentikasi gagal diverifikasi");
    }

    await this.prisma.authority.update({ where: { id: authority.id }, data: { lastUsedAt: new Date() } });
    await this.security.log(identityId, "credential.authenticated", { credentialId: authority.credentialId }, account.id);
    return { ok: true };
  }

  async revoke(identityId: string, authorityId: string): Promise<AuthorityView> {
    const account = await this.resolveAccount(identityId);
    const authority = await this.prisma.authority.findFirst({
      where: { id: authorityId, accountId: account.id },
    });
    if (!authority) throw new NotFoundException("Kredensial tidak ditemukan");

    const activeCount = await this.prisma.authority.count({ where: { accountId: account.id, status: "active" } });
    // ADR 006 §5: the account must keep ≥1 valid authority (mirrors identity guard).
    if (activeCount <= 1) throw new BadRequestException("Kredensial terakhir tidak bisa dicabut");

    const updated = await this.prisma.authority.update({
      where: { id: authority.id },
      data: { status: "revoked" as AuthorityStatus },
    });
    await this.security.log(identityId, "credential.revoked", { credentialId: authority.credentialId }, account.id);
    return toView(updated);
  }
}