// On-chain authority rotation as part of the credential lifecycle (V2).
//
// Canonical sequence: register new credential (existing approval flow) → current
// credential authorizes on-chain `update_authority` (this endpoint) → confirm chain
// state → revoke the old credential in DB. DB revocation is never described as
// rotation until the chain confirms the new authority: the old credential stays
// `active` while confirmation is pending, so DB authority ⊆ chain authority always
// holds outside the explicit in-flight window.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import type { Keypair, PasskeyAssertion, SolanaAdapter } from "@peridotvault/pid-solana";
import { coseToCompressedSecp256r1 } from "../credentials/cose";
import { ACCOUNT_TYPE_SMART, SolanaSelection } from "../common/chains";
import { ChainRegistryService } from "../chain/chain-registry.service";
import { MAX_TTL_SECS, relayerKeypair, solanaAdapter } from "../common/solana-relay";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import {
  BROADCAST_CHAIN_SOLANA,
  RelayerIdempotencyService,
} from "../relayer/relayer-idempotency.service";
import { RelayerEvents, absorbedLoss } from "../relayer/relayer-events";
import { CircuitBreakerService } from "../relayer/circuit-breaker.service";
import { RevocationMonitor } from "../relayer/revocation-monitor.service";
import type { RotateAuthorityResult } from "./dto/rotate.dto";

@Injectable()
export class RotateService {
  private readonly logger = new Logger(RotateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly security: SecurityEventService,
    private readonly chains: ChainRegistryService,
    private readonly idempotency: RelayerIdempotencyService,
    private readonly breaker: CircuitBreakerService,
    private readonly revocations: RevocationMonitor,
  ) {}

  /** Lazy pid-solana module (keeps @solana/web3.js out of Jest's transform graph). */
  private get pidSolana() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("@peridotvault/pid-solana") as typeof import("@peridotvault/pid-solana");
  }

  private relayer(): Keypair {
    return relayerKeypair(this.pidSolana, this.config);
  }

  private async adapter(selection?: SolanaSelection): Promise<SolanaAdapter> {
    const [rpcUrl, programId] = await Promise.all([this.chains.solanaRpcUrl(selection), this.chains.solanaProgramId(selection)]);
    return solanaAdapter(this.pidSolana, rpcUrl, programId);
  }

  async rotate(
    pid: string,
    dto: {
      oldCredentialId: string;
      newCredentialId: string;
      nonce: string;
      expiry: number;
      assertion: { id: string; signature: string; authenticatorData: string; clientDataJSON: string };
    },
    selection?: SolanaSelection,
  ): Promise<RotateAuthorityResult> {
    if (dto.oldCredentialId === dto.newCredentialId) {
      throw new BadRequestException("Replacement credential must differ from the current one");
    }
    if (dto.assertion.id !== dto.oldCredentialId) {
      throw new BadRequestException("Assertion must come from the current authority credential");
    }
    const adapter = await this.adapter(selection);
    const smart = await this.prisma.chainAccount.findFirst({
      where: { pid, accountType: ACCOUNT_TYPE_SMART },
    });
    if (!smart) throw new NotFoundException("Account not found");
    if (!(await adapter.isActivated(smart.address).catch(() => false))) {
      throw new ConflictException("Wallet must be activated before rotating authority");
    }

    // H3: fail-closed while the per-chain spend-rate breaker is open.
    await this.breaker.requireClosed(pid, BROADCAST_CHAIN_SOLANA, "rotate");

    const [oldCred, newCred] = await Promise.all([
      this.prisma.authority.findFirst({ where: { pid, credentialId: dto.oldCredentialId, status: "active" } }),
      this.prisma.authority.findFirst({ where: { pid, credentialId: dto.newCredentialId, status: "active" } }),
    ]);
    if (!oldCred) throw new BadRequestException("Unknown or inactive current credential");
    if (!newCred) throw new BadRequestException("Replacement credential is not registered and active");

    const chainNonce = BigInt(await adapter.getNonce(pid));
    if (BigInt(dto.nonce) !== chainNonce) {
      throw new ConflictException("Authorization is stale — please try again (a newer nonce is active)");
    }
    const chainTime = await adapter.chainTime().catch(() => 0);
    if (dto.expiry <= chainTime) throw new BadRequestException("Authorization expired — please try again");
    if (dto.expiry - chainTime > MAX_TTL_SECS) {
      throw new BadRequestException("Authorization lifetime exceeds 600 seconds — please try again");
    }

    const currentKey = coseToCompressedSecp256r1(Buffer.from(oldCred.publicKey));
    const newKey = coseToCompressedSecp256r1(Buffer.from(newCred.publicKey));
    const { b64urlToBytes } = this.pidSolana;
    const assertion: PasskeyAssertion = {
      credentialId: dto.assertion.id,
      signature: b64urlToBytes(dto.assertion.signature) as unknown as Uint8Array<ArrayBufferLike>,
      authenticatorData: b64urlToBytes(dto.assertion.authenticatorData) as unknown as Uint8Array<ArrayBufferLike>,
      clientDataJSON: b64urlToBytes(dto.assertion.clientDataJSON) as unknown as Uint8Array<ArrayBufferLike>,
    };

    // The relayer sponsors rotation (no reimbursement path — cost absorbed).
    // H2: claim the (pid, nonce, chain) slot first. An identical retry whose
    // chain state already shows the new authority completes idempotently;
    // different bytes under the same nonce are forbidden in claimSlot.
    const slotHash = createHash("sha256")
      .update(JSON.stringify(["rotate", dto.oldCredentialId, dto.newCredentialId, dto.nonce, dto.expiry]))
      .update(dto.assertion.signature)
      .digest("hex");
    const claim = await this.idempotency.claimSlot(
      pid,
      dto.nonce,
      BROADCAST_CHAIN_SOLANA,
      slotHash,
      "rotate",
    );
    if (claim.decision === "duplicate") {
      const done = await this.finishRotationIfConfirmed(
        adapter,
        pid,
        oldCred.id,
        dto,
        newKey,
        claim.signature,
      );
      if (done) return done;
      // This IS the in-flight slot and the chain does not confirm: run
      // resolve-then-act for this exact slot (guard skipped -- blocking our
      // own slot would brick retries, F1).
      return this.submitAndConfirm(adapter, pid, dto, chainNonce, currentKey, newKey, assertion, oldCred.id, claim.signature);
    }
    // H2.iv double-rotation guard on fresh claims only: no second rotation
    // while a DIFFERENT slot may still confirm (self-healing: stale slots
    // are released as expired, F1).
    await this.idempotency.assertNoInflightRotation(pid, BROADCAST_CHAIN_SOLANA, chainNonce);

    return this.submitAndConfirm(adapter, pid, dto, chainNonce, currentKey, newKey, assertion, oldCred.id, claim.signature);
  }

  /**
   * Shared broadcast + confirm + revoke tail (F1): both the duplicate-slot
   * resolve path and the fresh-claim path converge here. Post-confirmation
   * failures alert, never rebroadcast.
   */
  private async submitAndConfirm(
    adapter: SolanaAdapter,
    pid: string,
    dto: { oldCredentialId: string; newCredentialId: string; nonce: string; expiry: number },
    chainNonce: bigint,
    currentKey: Uint8Array,
    newKey: Uint8Array,
    assertion: PasskeyAssertion,
    oldCredId: string,
    slotSignature: string | null,
  ): Promise<RotateAuthorityResult> {
    const out = await this.idempotency.broadcastWithResolveThenAct({
      pid,
      nonce: dto.nonce,
      chain: BROADCAST_CHAIN_SOLANA,
      entryPoint: "rotate",
      broadcast: () =>
        adapter
          .submitRotateAuthorityTx(
            pid,
            currentKey as unknown as Uint8Array,
            newKey as unknown as Uint8Array,
            chainNonce,
            dto.expiry,
            assertion,
            this.relayer(),
          )
          .then((sig) => ({ signature: sig, result: null })),
      resolveState: async () => {
        const onChain = await adapter.getAuthority(pid).catch(() => null);
        if (onChain && Buffer.from(onChain).toString("hex") === Buffer.from(newKey).toString("hex")) {
          return { landed: true as const, signature: slotSignature };
        }
        const nonceNow = await adapter.getNonce(pid).catch(() => null);
        if (nonceNow == null) return { unreadable: true as const };
        if (nonceNow !== chainNonce) return { landed: true as const, signature: slotSignature };
        return { landed: false as const };
      },
    });
    const signature = out.signature;
    if (!signature) {
      await this.security.log(pid, RelayerEvents.rotationUnconfirmed, {
        chain: BROADCAST_CHAIN_SOLANA,
        nonce: dto.nonce,
        unattributed: true,
      });
      throw new ServiceUnavailableException(
        "Rotation was submitted but not confirmed on-chain yet. Your current credential still works — please try again in a moment.",
      );
    }

    // Confirm the chain actually rotated before touching DB state.
    const started = Date.now();
    const confirmed = await this.confirmRotation(adapter, pid, Buffer.from(newKey).toString("hex"));
    await this.security.log(pid, RelayerEvents.rotationLatency, {
      chain: BROADCAST_CHAIN_SOLANA,
      latencyMs: Date.now() - started,
      confirmed,
    });
    if (!confirmed) {
      await this.security.log(pid, RelayerEvents.rotationUnconfirmed, { signature });
      throw new ServiceUnavailableException(
        "Rotation was submitted but not confirmed on-chain yet. Your current credential still works — please try again in a moment.",
      );
    }

    await this.idempotency.recordOutcome(pid, dto.nonce, BROADCAST_CHAIN_SOLANA, "rotate", "confirmed", signature);
    await this.prisma.authority.update({
      where: { id: oldCredId },
      data: { status: "revoked" },
    });
    // H1.i: rotation revokes count toward the per-chain revocation spike rate.
    await this.revocations.recordRevocation(pid, BROADCAST_CHAIN_SOLANA).catch((err) =>
      this.logger.warn(`revocation record failed: ${(err as Error).message}`),
    );
    await this.security.log(pid, "credential.rotated", {
      signature,
      from: dto.oldCredentialId,
      to: dto.newCredentialId,
    });
    await this.reconcileRotationCost(pid, adapter, signature);
    return { signature, status: "confirmed" };
  }

  /**
   * Idempotent completion for a duplicate identical retry: when the chain
   * already shows the new authority, revoke + record without rebroadcast.
   * Returns null when the chain does not confirm (caller falls through to
   * resolve-then-act).
   */
  private async finishRotationIfConfirmed(
    adapter: SolanaAdapter,
    pid: string,
    oldCredId: string,
    dto: { oldCredentialId: string; newCredentialId: string; nonce: string },
    newKey: Uint8Array,
    signature: string | null,
  ): Promise<RotateAuthorityResult | null> {
    const confirmed = await this.confirmRotation(adapter, pid, Buffer.from(newKey).toString("hex")).catch(
      () => false,
    );
    if (!confirmed) return null;
    await this.prisma.authority.update({ where: { id: oldCredId }, data: { status: "revoked" } });
    await this.revocations.recordRevocation(pid, BROADCAST_CHAIN_SOLANA).catch((err) =>
      this.logger.warn(`revocation record failed: ${(err as Error).message}`),
    );
    if (signature) {
      await this.idempotency.recordOutcome(pid, dto.nonce, BROADCAST_CHAIN_SOLANA, "rotate", "confirmed", signature);
    }
    await this.security.log(pid, "credential.rotated", {
      signature,
      from: dto.oldCredentialId,
      to: dto.newCredentialId,
      idempotentReplay: true,
    });
    return { signature: signature ?? "unknown", status: "confirmed" };
  }

  /** Rotation cost is fully absorbed (no reimbursement path): fee → breaker + P&L. */
  private async reconcileRotationCost(
    pid: string,
    adapter: SolanaAdapter,
    signature: string,
  ): Promise<void> {
    const parsed = await adapter.parseTransaction(signature).catch(() => null);
    const absorbed = parsed?.fee != null ? absorbedLoss(0n, BigInt(parsed.fee)) : 0n;
    await this.security.log(pid, RelayerEvents.pnl, {
      signature,
      entryPoint: "rotate",
      chain: BROADCAST_CHAIN_SOLANA,
      absorbed: absorbed.toString(),
    });
    await this.breaker.recordAbsorbed(pid, BROADCAST_CHAIN_SOLANA, absorbed).catch((err) =>
      this.logger.warn(`breaker record failed: ${(err as Error).message}`),
    );
  }

  private async confirmRotation(adapter: SolanaAdapter, pid: string, newKeyHex: string): Promise<boolean> {
    for (let i = 0; i < 15; i++) {
      try {
        const onChain = Buffer.from(await adapter.getAuthority(pid)).toString("hex");
        if (onChain === newKeyHex) return true;
      } catch {
        // transient RPC error — keep polling
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }
}
