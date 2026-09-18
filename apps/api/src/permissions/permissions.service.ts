import { BadRequestException, Injectable } from "@nestjs/common";
import { DENIED_SELECTORS, buildGrantPayload, buildPermissionId } from "@peridotvault/pid-evm";
import { GrantPermissionDto } from "./dto/permission.dto";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** Longest permission lifetime (seconds): 30 days — mirrors MAX_PERMISSION_TTL. */
export const MAX_PERMISSION_TTL = 30 * 86400;

function isZeroAddress(a: string): boolean {
  return a.toLowerCase() === ZERO_ADDRESS;
}

function hexToBytes(h: string): Uint8Array {
  const clean = h.startsWith("0x") ? h.slice(2) : h;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface ValidatedGrant {
  permissionId: string;
  grantPayload: string; // hex challenge the owner passkey must sign
}

@Injectable()
export class PermissionsService {
  /**
   * Validate a permission grant request against the on-chain scope rules
   * (mirrors `grantPermission` hygiene + `WHITEPAPER.md` §10 scope kinds) and
   * return the canonical permission id + owner challenge. Pure: no DB, no chain.
   * Submission-time ownership (pid → account) is enforced by the relay path.
   */
  validateGrant(dto: GrantPermissionDto, nowSec = Math.floor(Date.now() / 1000)): ValidatedGrant {
    const { kind, target, selector, token, to } = dto;
    const perTxCap = BigInt(dto.perTxCap);
    const totalLimit = BigInt(dto.totalLimit);
    if (dto.validUntil <= nowSec) throw new BadRequestException("validUntil must be in the future");
    if (dto.validUntil <= dto.validAfter) throw new BadRequestException("validUntil must exceed validAfter");
    if (dto.validUntil - nowSec > MAX_PERMISSION_TTL) {
      throw new BadRequestException("permission lifetime exceeds 30 days");
    }
    if (dto.deadline <= nowSec || dto.deadline - nowSec > 600) {
      throw new BadRequestException("deadline must be within a 600s TTL");
    }
    if (dto.sessionX === "0x" + "00".repeat(32) && dto.sessionY === "0x" + "00".repeat(32)) {
      throw new BadRequestException("session key must not be zero");
    }
    const account = dto.account.toLowerCase();
    const factory = dto.factory.toLowerCase();
    if (kind === 1) {
      if (isZeroAddress(target) || target.toLowerCase() === account || target.toLowerCase() === factory) {
        throw new BadRequestException("nonfinancial target must be a third-party contract");
      }
      if (selector === "0x00000000") throw new BadRequestException("selector must be set");
      if ((DENIED_SELECTORS as readonly string[]).includes(selector.toLowerCase())) {
        throw new BadRequestException(`selector ${selector} is financial and needs a financial grant`);
      }
      if (!isZeroAddress(token) || !isZeroAddress(to)) {
        throw new BadRequestException("nonfinancial grants must leave token/to unset");
      }
    } else if (kind === 2) {
      if (!isZeroAddress(token)) throw new BadRequestException("ETH grants must leave token unset");
      if (isZeroAddress(to) || to.toLowerCase() === account) {
        throw new BadRequestException("ETH grants need an explicit third-party recipient");
      }
    } else {
      if (isZeroAddress(token) || token.toLowerCase() === account) {
        throw new BadRequestException("token grants need an explicit token contract");
      }
      if (isZeroAddress(to)) throw new BadRequestException("token grants need an explicit recipient");
    }
    if (kind !== 1 && (perTxCap <= 0n || totalLimit < perTxCap)) {
      throw new BadRequestException("financial grants need 0 < perTxCap <= totalLimit");
    }
    const scope = {
      sessionX: hexToBytes(dto.sessionX),
      sessionY: hexToBytes(dto.sessionY),
      kind,
      target,
      selector: hexToBytes(dto.selector),
      token,
      to,
      nftId: BigInt(dto.nftId),
      validUntil: dto.validUntil,
      salt: hexToBytes(dto.salt),
    };
    const permissionId = buildPermissionId(dto.chainId, dto.account, scope);
    const payload = buildGrantPayload({
      chainId: dto.chainId,
      account: dto.account,
      permissionId,
      scope,
      perTxCap,
      totalLimit,
      validAfter: dto.validAfter,
      nonce: BigInt(dto.nonce),
      deadline: dto.deadline,
    });
    const toHex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
    return { permissionId: toHex(permissionId), grantPayload: toHex(payload) };
  }

  deniedSelectors(): string[] {
    return [...DENIED_SELECTORS];
  }
}
