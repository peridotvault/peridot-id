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
   *
   * Ownership (ANT-284): there is NO server-side EVM submission path for grants — the
   * returned `grantPayload` must be signed by the owner passkey and lands
   * on-chain via the client. (The account-scoped EVM relayer in
   * `evm-activation.service.ts` only deploys account contracts, never submits
   * grants.) The signature IS the pid→account binding: `account`
   * and `chainId` are part of the signed payload (`permissionId` binds both),
   * so a grant validated for account A can never execute as account B, and a
   * non-owner cannot produce a valid submission. Any future server relay MUST
   * re-check (caller pid owns `account`) before forwarding — mirroring how the
   * Solana relay paths scope every vault/credential lookup by the
   * authenticated pid (`sponsored-withdraw.service.ts`, `rotate.service.ts`).
   */
  validateGrant(dto: GrantPermissionDto, nowSec = Math.floor(Date.now() / 1000)): ValidatedGrant {
    const { kind, target, selector, token, to } = dto;
    if (dto.feeLimit == null || !/^\d+$/.test(dto.feeLimit)) {
      throw new BadRequestException("feeLimit is required (uint string; 0 = only zero-fee execs pass)");
    }
    const perTxCap = BigInt(dto.perTxCap);
    const totalLimit = BigInt(dto.totalLimit);
    const feeLimit = BigInt(dto.feeLimit);
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
    // ANT-556 Option A: NONFINANCIAL-only. Kinds 2-5 are removed on-chain;
    // reject here (defense in depth) — no kind-2/token branches remain.
    if (kind !== 1) {
      throw new BadRequestException("financial permission kinds were removed (ANT-556 Option A): only kind 1 allowed");
    }
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
    // NONFINANCIAL grants carry no value caps: perTxCap/totalLimit/nftId must be zero.
    // (Contract enforces `perTxCap == 0 && totalLimit == 0 && nftId == 0` — fail closed here too.)
    if (perTxCap !== 0n || totalLimit !== 0n || BigInt(dto.nftId) !== 0n) {
      throw new BadRequestException("nonfinancial grants must leave perTxCap/totalLimit/nftId unset (zero)");
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
    // ANT-556: feeLimit is REQUIRED (no default). 0n is explicit (only zero-fee
    // execs pass on-chain) — the DTO guarantees presence; pass through as-is.
    const payload = buildGrantPayload({
      chainId: dto.chainId,
      account: dto.account,
      permissionId,
      scope,
      perTxCap,
      totalLimit,
      feeLimit,
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
