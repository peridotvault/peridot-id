import { BadRequestException, Injectable } from "@nestjs/common";
import { RegisterSessionDto } from "./dto/session-key.dto";

/** Longest session lifetime (seconds): 24h — mirrors SESSION_MAX_TTL_SECS. */
export const SESSION_MAX_TTL = 86_400;
/** Session inactivity timeout (seconds): 30min — mirrors SESSION_INACTIVITY_SECS. */
export const SESSION_INACTIVITY_TIMEOUT = 1_800;

function hexToBytes(h: string): Uint8Array {
  const clean = h.startsWith("0x") ? h.slice(2) : h;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface ValidatedSessionGrant {
  sessionAddress: string;
  registerPayload: string; // hex challenge the owner passkey must sign
}

@Injectable()
export class SessionKeysService {
  /** Lazy pid-solana module (keeps @solana/web3.js out of Jest's transform graph). */
  private get pidSolana() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("@peridotvault/pid-solana") as typeof import("@peridotvault/pid-solana");
  }

  /**
   * Validate a session grant against the on-chain scope rules (mirrors
   * `register_session` hygiene (WHITEPAPER.md §11) and return the canonical session
   * address + owner challenge. Pure: no DB, no chain. Submission-time
   * ownership (pid → vault) is enforced by the relay path.
   */
  async validateGrant(dto: RegisterSessionDto, nowSec = Math.floor(Date.now() / 1000)): Promise<ValidatedSessionGrant> {
    if (dto.expiresAt <= nowSec) throw new BadRequestException("expiresAt must be in the future");
    if (dto.expiresAt - nowSec > SESSION_MAX_TTL) {
      throw new BadRequestException("session lifetime exceeds 24 hours");
    }
    if (dto.deadline <= nowSec || dto.deadline - nowSec > 600) {
      throw new BadRequestException("deadline must be within a 600s TTL");
    }
    if (dto.recordedHasAuthority && !dto.recordedAuthority) {
      throw new BadRequestException("recordedAuthority is required when recordedHasAuthority is set");
    }
    const { PublicKey, buildRegisterSessionPayload, deriveSessionAddress } = this.pidSolana;
    const sessionKey = new PublicKey(dto.sessionPubkey);
    if (sessionKey.equals(new PublicKey(dto.allowedProgram))) {
      throw new BadRequestException("session key and game program must differ");
    }
    const accountId32 = hexToBytes(dto.accountId);
    const { address } = deriveSessionAddress(accountId32, sessionKey);
    const recordedAuthority = dto.recordedHasAuthority && dto.recordedAuthority
      ? new PublicKey(dto.recordedAuthority).toBytes()
      : new Uint8Array(32);
    const payload = await buildRegisterSessionPayload({
      accountId32,
      nonce: BigInt(dto.nonce),
      sessionPubkey: sessionKey,
      allowedProgram: new PublicKey(dto.allowedProgram),
      expiresAt: dto.expiresAt,
      recordedHasAuthority: dto.recordedHasAuthority,
      recordedAuthority,
      recordedSlot: BigInt(dto.recordedSlot),
      expiry: dto.deadline,
    });
    const toHex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
    return { sessionAddress: address.toBase58(), registerPayload: toHex(payload) };
  }

  constants(): { maxTtlSecs: number; inactivitySecs: number; stateLen: number } {
    return { maxTtlSecs: SESSION_MAX_TTL, inactivitySecs: SESSION_INACTIVITY_TIMEOUT, stateLen: 205 };
  }
}
