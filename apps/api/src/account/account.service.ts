import { Injectable, NotFoundException } from "@nestjs/common";
import { ChainAccountStatus } from "@prisma/client";
import { deriveEvmSmartAccountAddressBound } from "@peridotvault/pid-evm";
import { ChainRegistryService } from "../chain/chain-registry.service";
import { ACCOUNT_TYPE_SMART, SOLANA_NAMESPACE, SolanaSelection, solanaReferenceFor } from "../common/chains";
import { deriveSmartAccountAddress } from "../common/smart-account";
import { coseToCompressedSecp256r1, coseToRawXy } from "../credentials/cose";
import { isP2002 } from "../prisma/prisma-error";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";

export interface ChainAccountView {
  id: string;
  chainNamespace: string;
  chainReference: string;
  address: string;
  accountType: string;
  status: ChainAccountStatus;
  activationBalance: number | null;
  activationRequired: number | null;
  createdAt: Date;
}

export function toChainView(ca: {
  id: string;
  chain: { namespace: string; reference: string };
  address: string;
  accountType: string;
  status: ChainAccountStatus;
  activationBalance: bigint | null;
  activationRequired: bigint | null;
  createdAt: Date;
}): ChainAccountView {
  return {
    id: ca.id,
    chainNamespace: ca.chain.namespace,
    chainReference: ca.chain.reference,
    address: ca.address,
    accountType: ca.accountType,
    status: ca.status,
    activationBalance: ca.activationBalance == null ? null : Number(ca.activationBalance),
    activationRequired: ca.activationRequired == null ? null : Number(ca.activationRequired),
    createdAt: ca.createdAt,
  };
}

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly security: SecurityEventService,
    private readonly chains: ChainRegistryService,
  ) {}

  private async programId(selection?: SolanaSelection): Promise<string> {
    return this.chains.solanaProgramId(selection);
  }

  /**
   * EVM counterfactual rows: one B1-bound CREATE2 address per deployable
   * registry chain, each from its own factory/implementation contracts (same
   * values everywhere today = one address everywhere). Skipped until a chain
   * has both contracts.
   *
   * B1 (ANT-866): the address commits to the claiming passkey, so rows are
   * deferred until an active authority exists — a keyless row would advertise
   * an unclaimable funding target. The activation path heals any pre-binding
   * row to the bound address before broadcasting.
   */
  /**
   * Raw (x, y) coords for a recorded 33B compressed claiming key (ANT-866/R2).
   * Resolves through the authority table (any status — the claiming row may
   * be revoked post-rotation) instead of hand-rolled EC decompression.
   * Returns null when no credential row matches (key material gone).
   */
  private async claimKeyXy(pid: string, claimAuthority: Buffer): Promise<{ x: Buffer; y: Buffer } | null> {
    const rows = await this.prisma.authority.findMany({ where: { pid } });
    const hit = rows.find((r) => coseToCompressedSecp256r1(Buffer.from(r.publicKey)).equals(claimAuthority));
    return hit ? coseToRawXy(Buffer.from(hit.publicKey)) : null;
  }

  private async ensureEvmRows(pid: string): Promise<void> {
    const authority = await this.prisma.authority.findFirst({
      where: { pid, status: "active" },
      orderBy: { createdAt: "asc" },
    });
    if (!authority) return;
    const { x, y } = coseToRawXy(Buffer.from(authority.publicKey));
    for (const chain of await this.chains.deployableEvmChains()) {
      const factory = chain.contracts.find((k) => k.type === "factory")?.address;
      const implementation = chain.contracts.find((k) => k.type === "account_implementation")?.address;
      if (!factory || !implementation) continue;
      const existing = await this.prisma.chainAccount.findFirst({
        where: { pid, chainId: chain.id, accountType: ACCOUNT_TYPE_SMART },
      });
      // ANT-866/R2: derive under the RECORDED claiming key when the row has
      // one — re-pointing from oldest-active after a rotation writes an
      // address/claimAuthority skew pair (address=K-new, key=K-old) pointing
      // funding at an unclaimable address.
      const recorded = existing?.claimAuthority ? Buffer.from(existing.claimAuthority) : null;
      const recordedXy = recorded ? await this.claimKeyXy(pid, recorded) : null;
      if (recorded && !recordedXy) {
        // Claiming key material is gone (credential row deleted): never
        // clobber — log and leave the row for operator reconciliation.
        await this.security.log(pid, "account.evm_repoint_skipped", { chain: chain.id }).catch(() => undefined);
        continue;
      }
      const key = recordedXy ?? { x, y };
      const evm = deriveEvmSmartAccountAddressBound(
        pid,
        new Uint8Array(key.x),
        new Uint8Array(key.y),
        factory,
        implementation,
      );
      if (!existing) {
        try {
          await this.prisma.chainAccount.create({
            data: {
              pid,
              chainId: chain.id,
              address: evm.address,
              accountType: ACCOUNT_TYPE_SMART,
              // Provisional claiming key (oldest active); activation-heal
              // overwrites with the asserting key (ANT-866/F1).
              claimAuthority: new Uint8Array(coseToCompressedSecp256r1(Buffer.from(authority.publicKey))),
            },
          });
        } catch (err) {
          if (!isP2002(err)) throw err;
        }
      } else if (existing.address !== evm.address) {
        await this.prisma.chainAccount.update({
          where: { id: existing.id },
          data: {
            address: evm.address,
            activationBalance: null,
            activationRequired: null,
            ...(existing.status === "active" ? {} : { status: "inactivated" as const }),
          },
        });
      }
    }
  }

  /**
   * Idempotent wallet setup for the token identity: ensures the Solana
   * smart-account row (derived PDA) plus EVM counterfactuals, then returns
   * every chain row. 1 identity = 1 personal wallet. The optional selection
   * scopes the Solana row to the devnet/testnet chain (one smart account per
   * chain); omitted (default) preserves the historical single-row behavior.
   */
  async ensureAccount(pid: string, selection?: SolanaSelection): Promise<ChainAccountView[]> {
    // Resolve the program id (registry) before any DB write so it can't orphan rows.
    const programId = await this.programId(selection);

    // B1 (ANT-866): the Solana PDA commits to the claiming passkey, so the
    // row is deferred until an active authority exists — a keyless row would
    // advertise an unclaimable funding target. The activation path heals any
    // pre-binding row to the bound address before broadcasting.
    const authority = await this.prisma.authority.findFirst({
      where: { pid, status: "active" },
      orderBy: { createdAt: "asc" },
    });
    const existingChain = await this.prisma.chainAccount.findFirst({
      where: {
        pid,
        accountType: ACCOUNT_TYPE_SMART,
        ...(selection ? { chain: { namespace: SOLANA_NAMESPACE, reference: solanaReferenceFor(selection) } } : {}),
      },
    });
    // ANT-866/F1+R1: derivation key is the RECORDED claiming key when the row
    // has one — never oldest-active unconditionally. Oldest flips on rotation
    // (revoke) and may differ at multi-key activation; re-deriving from it
    // would clobber a healed row back to an unclaimable address (availability
    // outage; on-chain stays fail-closed). Provisional oldest applies only to
    // rows without a recorded key (setup / legacy).
    const recordKey = existingChain?.claimAuthority
      ? Buffer.from(existingChain.claimAuthority)
      : authority
        ? coseToCompressedSecp256r1(Buffer.from(authority.publicKey))
        : null;
    const derived = recordKey ? deriveSmartAccountAddress(pid, programId, recordKey).address : null;
    if (!existingChain) {
      if (recordKey === null || derived === null) {
        // No passkey yet: defer the Solana row too (see above). EVM rows
        // defer the same way; getChains throws NotFound until any row lands.
      } else {
        const chainId = await this.chains.solanaChainIdOrThrow(selection);
        try {
          await this.prisma.chainAccount.create({
            data: {
              pid,
              chainId,
              address: derived,
              accountType: ACCOUNT_TYPE_SMART,
              claimAuthority: Buffer.from(recordKey),
            },
          });
          await this.security.log(pid, "account.created", {});
        } catch (err) {
          // concurrent create → already present; P2002 is fine.
          if (!isP2002(err)) throw err;
        }
      }
    } else if (derived !== null && existingChain.address !== derived) {
      // Re-point the stored address to the current program id's PDA (e.g. after an on-chain
      // program redeploy changed the program id). Without this, balance reads and activation
      // would target a stale address that holds no funds. The recorded
      // claiming key is NEVER overwritten here (R1); the `inactivated` reset
      // stays off rows that are already `active` (a live vault keeps serving
      // while its address re-points).
      await this.prisma.chainAccount.update({
        where: { id: existingChain.id },
        data: {
          address: derived,
          activationBalance: null,
          activationRequired: null,
          ...(existingChain.status === "active" ? {} : { status: "inactivated" as const }),
        },
      });
    }

    await this.ensureEvmRows(pid);

    return this.getChains(pid);
  }

  /** Every chain row of the token identity's wallet. */
  async getChains(pid: string): Promise<ChainAccountView[]> {
    const rows = await this.prisma.chainAccount.findMany({
      where: { pid },
      include: { chain: true },
      orderBy: { createdAt: "asc" },
    });
    if (rows.length === 0) throw new NotFoundException("Account not found");
    return rows.map(toChainView);
  }
}
