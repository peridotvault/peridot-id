// External-wallet authentication and linking (stage 2 of
// docs/plan/02-external-wallet-auth.md).
//
// Flow: challenge → wallet signs the server-built message → verify. A verified
// address is a CREDENTIAL (`IdentityCredential`) for exactly one PID, keyed by
// (namespace, address) — chain/address based, never extension-brand based.
// Verification never creates an identity: an unknown address mints the ordinary
// claim ticket, so the existing PID-picker flow owns account creation and the
// "no implicit merge" rule.
//
// Credentials are shared with the other login methods, so `@@unique([provider,
// providerUserId])` is the global uniqueness rule: an address already linked to
// another PID surfaces as 409 and is never reassigned or merged.
import { BadRequestException, ConflictException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { SecurityEventService } from "../../security/security-event.service";
import { ClaimService } from "../claim.service";
import { adapterFor } from "../provider-adapters";
import { SsoService } from "../sso.service";
import { UsageService } from "../../usage/usage.service";
import { normalizeWalletAddress, verifyWalletSignature, type WalletNamespace } from "./wallet-signature";
import { isP2002 } from "../../prisma/prisma-error";

/** Proof-of-ownership challenges are short-lived on purpose. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface WalletChallengeView {
  challengeId: string;
  message: string;
  expiresAt: string;
  namespace: WalletNamespace;
  address: string;
}

export interface LinkedWalletView {
  id: string;
  namespace: WalletNamespace;
  address: string;
  linkedAt: string;
  lastLoginAt: string | null;
}

/** What a verified signature resolves to, before the controller picks a response. */
export type WalletVerifyResult =
  | { kind: "session"; pid: string; pidCode?: string }
  | { kind: "claim"; ticketId: string };

@Injectable()
export class WalletAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly security: SecurityEventService,
    private readonly claim: ClaimService,
    private readonly sso: SsoService,
    private readonly usage: UsageService,
  ) {}

  /**
   * Issue a single-use challenge bound to (namespace, reference, address,
   * action, pid, origin). The message is stored verbatim: the client signs
   * exactly these bytes, so the server never re-derives what was signed.
   */
  async challenge(
    input: {
      providerCode?: "phantom" | "metamask";
      namespace: WalletNamespace;
      reference: string;
      address: string;
      action?: "login" | "link";
      returnTo?: string;
      clientId?: string;
      codeChallenge?: string;
    },
    ctx: { pid?: string; origin?: string },
  ): Promise<WalletChallengeView> {
    const action = input.action ?? "login";
    if (action === "link" && !ctx.pid) throw new UnauthorizedException("Sign in before linking a wallet");
    // Bind the cross-origin target now: a third-party app gets its pid_code
    // from `verify`, with no PeridotID-hosted window in between.
    const target =
      action === "login" && (input.returnTo || input.clientId)
        ? await this.sso.resolveReturnTo(input.returnTo, input.clientId)
        : null;
    if (action === "login" && (input.returnTo || input.clientId) && !target) {
      throw new BadRequestException("returnTo is not an allowed origin");
    }

    if (input.providerCode === "metamask" && input.namespace !== "evm") {
      throw new BadRequestException("This connector does not implement that namespace");
    }
    if (input.providerCode) {
      const provider = await this.prisma.loginProvider.findUnique({ where: { code: input.providerCode } });
      if (!provider?.isAvailable || provider.protocol !== "wallet_signature") throw new BadRequestException("Provider unavailable");
    } else {
      // Legacy clients omit the connector: attribution stays unknown, but the
      // chain family still needs at least one globally enabled wallet adapter.
      const providers = await this.prisma.loginProvider.findMany({
        where: { protocol: "wallet_signature", isAvailable: true },
        select: { code: true },
      });
      if (!providers.some(provider => adapterFor(provider.code)?.namespace === input.namespace)) {
        throw new BadRequestException("No wallet provider is available for this chain");
      }
    }
    const address = normalizeWalletAddress(input.namespace, input.address);
    if (!address) {
      throw new BadRequestException(
        input.namespace === "evm" ? "Invalid EVM address" : "Invalid Solana address",
      );
    }

    const nonce = randomBytes(16).toString("hex");
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
    const message = buildMessage({
      namespace: input.namespace,
      reference: input.reference,
      address,
      action,
      nonce,
      origin: ctx.origin ?? "https://peridot.id",
      issuedAt,
      expiresAt,
    });

    const row = await this.prisma.walletAuthChallenge.create({
      data: {
        providerCode: input.providerCode ?? null,
        namespace: input.namespace,
        reference: input.reference,
        address,
        action,
        pid: ctx.pid ?? null,
        origin: ctx.origin ?? null,
        redirectTo: target?.redirectTo ?? null,
        clientId: target?.clientId ?? null,
        codeChallenge: input.codeChallenge ?? null,
        message,
        expiresAt,
      },
    });

    return {
      challengeId: row.id,
      message,
      expiresAt: expiresAt.toISOString(),
      namespace: input.namespace,
      address,
    };
  }

  /**
   * Verify a login proof. Returning address → session; new address → claim
   * ticket (the caller sets the claim cookie and the PID picker takes over).
   */
  async verifyLogin(challengeId: string, signature: string): Promise<WalletVerifyResult> {
    const challenge = await this.consume(challengeId, signature, "login");
    const existing = await this.prisma.identityCredential.findUnique({
      where: {
        provider_providerUserId: {
          provider: challenge.namespace,
          providerUserId: challenge.address,
        },
      },
      include: { identity: true },
    });

    if (!existing) {
      const ticketId = await this.claim.mintCredential(
        { provider: challenge.namespace, providerUserId: challenge.address, email: null },
        undefined,
        challenge.redirectTo
          ? { redirectTo: challenge.redirectTo, clientId: challenge.clientId ?? undefined, loginProviderCode: challenge.providerCode ?? undefined }
          : undefined,
      );
      return { kind: "claim", ticketId };
    }
    if (existing.identity.status !== "active") {
      throw new UnauthorizedException("This identity is not active");
    }
    await this.prisma.identityCredential.update({ where: { id: existing.id }, data: { lastLoginAt: new Date() } });
    // App-bound logins are the one metered event (stage 5). First-party logins
    // carry no clientId, so they never reach here.
    if (challenge.clientId) await this.usage.recordWalletLogin(challenge.clientId, existing.pid);
    return { kind: "session", pid: existing.pid, pidCode: await this.pidCodeFor(challenge, existing.pid) };
  }

  /**
   * Link the proven wallet to the caller's PID. Requires a challenge issued
   * with action `link` for that same pid — a login challenge can never be
   * reused to attach an address to a different account.
   */
  async link(challengeId: string, signature: string, pid: string): Promise<LinkedWalletView> {
    const challenge = await this.consume(challengeId, signature, "link");
    if (challenge.pid !== pid) throw new UnauthorizedException("This challenge belongs to another session");

    try {
      const row = await this.prisma.identityCredential.create({
        data: {
          pid,
          provider: challenge.namespace,
          providerUserId: challenge.address,
          email: null,
          lastLoginAt: new Date(),
        },
      });
      await this.security.log(pid, "wallet.linked", {
        namespace: challenge.namespace,
        address: challenge.address,
      });
      return toLinkedView(row);
    } catch (err) {
      // Global uniqueness: the address already belongs to someone (or was just
      // claimed). Never reassign, never merge — the caller must sign in as the
      // owning identity instead.
      if (isP2002(err)) throw new ConflictException("This wallet is already linked to a PeridotID");
      throw err;
    }
  }

  /**
   * One-time SSO code for the app bound at challenge time. Verified apps only —
   * same rule as the Google/passkey paths (an unverified app needs explicit
   * consent, and a wallet challenge is never a consent screen). Undefined means
   * "signed in, no code"; it never fails the login itself.
   */
  private async pidCodeFor(
    challenge: { providerCode?: string | null; redirectTo: string | null; clientId: string | null; codeChallenge: string | null; namespace: string },
    pid: string,
  ): Promise<string | undefined> {
    if (!challenge.redirectTo) return undefined;
    const resolved = await this.sso.resolveReturnTo(challenge.redirectTo, challenge.clientId ?? undefined);
    if (!resolved) return undefined;
    try {
      this.sso.requireVerifiedForAutoIssue(resolved);
      // Wallet switches are per extension: Phantom is the Solana injected
      // wallet, MetaMask the EVM one (namespace is brand-agnostic on the wire).
      return await this.sso.issue(pid, resolved.redirectTo, {
        clientId: resolved.clientId,
        method: challenge.providerCode ?? undefined,
        ...(challenge.codeChallenge ? { codeChallenge: challenge.codeChallenge } : {}),
      });
    } catch {
      return undefined;
    }
  }

  /** Wallet credentials linked to this PID (login-method management UI). */
  async list(pid: string): Promise<LinkedWalletView[]> {
    const rows = await this.prisma.identityCredential.findMany({
      where: { pid, provider: { in: ["solana", "evm"] } },
      orderBy: { linkedAt: "asc" },
    });
    return rows.map(toLinkedView);
  }

  /**
   * Unlink a wallet. Refuses to remove the identity's LAST credential: an
   * identity with no login method left would be unrecoverable.
   */
  async unlink(pid: string, credentialId: string): Promise<{ ok: true }> {
    const row = await this.prisma.identityCredential.findUnique({ where: { id: credentialId } });
    if (!row || row.pid !== pid || !["solana", "evm"].includes(row.provider)) {
      throw new NotFoundException("Wallet not linked");
    }
    const total = await this.prisma.identityCredential.count({ where: { pid } });
    if (total <= 1) {
      throw new ConflictException("This is your only login method — add another before unlinking this wallet.");
    }
    await this.prisma.identityCredential.delete({ where: { id: row.id } });
    await this.security.log(pid, "wallet.unlinked", { namespace: row.provider, address: row.providerUserId });
    return { ok: true };
  }

  /**
   * Load → check → verify → consume, in that order. The consume is a
   * conditional UPDATE, so of two concurrent verifies of the same challenge
   * exactly one wins (`count === 1`); the loser sees "already used".
   */
  private async consume(challengeId: string, signature: string, action: "login" | "link") {
    const challenge = await this.prisma.walletAuthChallenge.findUnique({ where: { id: challengeId } });
    if (!challenge || challenge.action !== action) {
      throw new BadRequestException("Unknown challenge — request a new one");
    }
    if (challenge.consumedAt || challenge.expiresAt <= new Date()) {
      throw new BadRequestException("Challenge expired or already used — request a new one");
    }
    const ok = await verifyWalletSignature({
      namespace: challenge.namespace as WalletNamespace,
      address: challenge.address,
      message: challenge.message,
      signature,
    });
    if (!ok) throw new UnauthorizedException("Signature does not prove this address");

    const consumed = await this.prisma.walletAuthChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw new BadRequestException("Challenge expired or already used — request a new one");
    return challenge;
  }
}

/**
 * Human-readable message the wallet displays and signs.
 *
 * Wallets auto-detect `<domain> wants you to sign in with your <chain> account:`
 * as SIWS/EIP-4361 and then validate it strictly — Phantom refuses anything
 * non-compliant with "The app's signature request cannot be shown due to invalid
 * formatting" (siwParseErrorDescription). So the layout follows CAIP-122: the
 * domain is the requesting page's host (port included, never a scheme), `URI` is
 * its origin. Solana omits the (optional) chain line — see below; EVM carries the
 * wallet's real EIP-155 chain. The server verifies the exact stored bytes, so any
 * change here only invalidates challenges already in flight.
 *
 * Statement text stays printable ASCII: the SIWS grammar allows only URI
 * reserved/unreserved characters and spaces, so a typographic dash ("—")
 * fails the parse. Keep it plain.
 */
function buildMessage(input: {
  namespace: WalletNamespace;
  reference: string;
  address: string;
  action: "login" | "link";
  nonce: string;
  origin: string;
  issuedAt: Date;
  expiresAt: Date;
}): string {
  const solana = input.namespace === "solana";
  let domain = input.origin;
  try {
    domain = new URL(input.origin).host;
  } catch {
    domain = input.origin.replace(/^https?:\/\//, "");
  }
  return [
    `${domain} wants you to sign in with your ${solana ? "Solana" : "Ethereum"} account:`,
    input.address,
    "",
    input.action === "link"
      ? "Link this wallet to your PeridotID. This proves ownership only - no funds move and no spending is approved."
      : "Sign in to PeridotID. This proves ownership only - no funds move and no spending is approved.",
    "",
    `URI: ${input.origin}`,
    "Version: 1",
    // Solana: no Chain ID line. Phantom compares it with the wallet's own network
    // and refuses on a mismatch ("chain ID does not match"), while the injected
    // provider never exposes that network for us to match. The field is optional
    // in SIWS, so omitting it works on mainnet, devnet and localnet alike. EVM
    // keeps it — providers answer `eth_chainId`, so the value is always the
    // wallet's real chain (required by EIP-4361).
    ...(solana ? [] : [`Chain ID: ${input.reference}`]),
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt.toISOString()}`,
    `Expiration Time: ${input.expiresAt.toISOString()}`,
  ].join("\n");
}

function toLinkedView(row: {
  id: string;
  provider: string;
  providerUserId: string;
  linkedAt: Date;
  lastLoginAt: Date | null;
}): LinkedWalletView {
  return {
    id: row.id,
    namespace: row.provider as WalletNamespace,
    address: row.providerUserId,
    linkedAt: row.linkedAt.toISOString(),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
  };
}
