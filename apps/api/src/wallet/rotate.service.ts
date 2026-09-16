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
import type { Keypair, PasskeyAssertion, SolanaAdapter } from "@peridotvault/pid-solana";
import { coseToCompressedSecp256r1 } from "../credentials/cose";
import { ACCOUNT_TYPE_SMART } from "../common/chains";
import { MAX_TTL_SECS, relayerKeypair, solanaAdapter } from "../common/solana-relay";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import type { RotateAuthorityResult } from "./dto/rotate.dto";

@Injectable()
export class RotateService {
  private readonly logger = new Logger(RotateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly security: SecurityEventService,
  ) {}

  /** Lazy pid-solana module (keeps @solana/web3.js out of Jest's transform graph). */
  private get pidSolana() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("@peridotvault/pid-solana") as typeof import("@peridotvault/pid-solana");
  }

  private relayer(): Keypair {
    return relayerKeypair(this.pidSolana, this.config);
  }

  private adapter(): SolanaAdapter {
    return solanaAdapter(this.pidSolana, this.config);
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
  ): Promise<RotateAuthorityResult> {
    if (dto.oldCredentialId === dto.newCredentialId) {
      throw new BadRequestException("Replacement credential must differ from the current one");
    }
    if (dto.assertion.id !== dto.oldCredentialId) {
      throw new BadRequestException("Assertion must come from the current authority credential");
    }
    const adapter = this.adapter();
    const smart = await this.prisma.chainAccount.findFirst({
      where: { pid, accountType: ACCOUNT_TYPE_SMART },
    });
    if (!smart) throw new NotFoundException("Account not found");
    if (!(await adapter.isActivated(smart.address).catch(() => false))) {
      throw new ConflictException("Wallet must be activated before rotating authority");
    }

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
    const signature = await adapter.submitRotateAuthorityTx(
      pid,
      currentKey as unknown as Uint8Array,
      newKey as unknown as Uint8Array,
      chainNonce,
      dto.expiry,
      assertion,
      this.relayer(),
    );

    // Confirm the chain actually rotated before touching DB state.
    const confirmed = await this.confirmRotation(adapter, pid, Buffer.from(newKey).toString("hex"));
    if (!confirmed) {
      await this.security.log(pid, "credential.rotation.unconfirmed", { signature });
      throw new ServiceUnavailableException(
        "Rotation was submitted but not confirmed on-chain yet. Your current credential still works — please try again in a moment.",
      );
    }

    await this.prisma.authority.update({
      where: { id: oldCred.id },
      data: { status: "revoked" },
    });
    await this.security.log(pid, "credential.rotated", {
      signature,
      from: dto.oldCredentialId,
      to: dto.newCredentialId,
    });
    return { signature, status: "confirmed" };
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
