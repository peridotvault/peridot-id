// Peridot-sponsored withdrawals. The smart account (PDA) cannot be a Solana fee payer, so
// Peridot's relayer signs the transaction and floats the network fee; the smart account
// reimburses `relay_fee` (network fee × (1 + margin), same margin as activation) to the
// Peridot treasury inside the same transaction. The passkey assertion is produced client-side
// and verified by the program on-chain; the server only validates shape, balance and fee.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ChainAccount } from "@prisma/client";
import type { Keypair, PasskeyAssertion, PublicKey, SolanaAdapter } from "@peridotvault/pid-solana";
import { coseToCompressedSecp256r1 } from "../credentials/cose";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";

export interface WithdrawQuote {
  relayFeeLamports: string;
  chainTime: number;
}

export interface SponsoredWithdrawResult {
  signature: string;
  relayFeeLamports: string;
  status: "confirmed" | "pending";
}

const ACCOUNT_TYPE_SMART = "smart_account";
const DEFAULT_MARGIN = "0.5";

@Injectable()
export class SponsoredWithdrawService {
  private readonly logger = new Logger(SponsoredWithdrawService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly security: SecurityEventService,
  ) {}

  private rpcUrl(): string {
    return this.config.get<string>("PID_SOLANA_RPC_URL", "https://api.devnet.solana.com");
  }

  private marginRate(): number {
    const n = Number(this.config.get<string>("PID_ACTIVATION_MARGIN_RATE", DEFAULT_MARGIN));
    return Number.isFinite(n) && n >= 0 ? n : Number(DEFAULT_MARGIN);
  }

  /** Lazy pid-solana module (keeps @solana/web3.js out of Jest's transform graph). */
  private get pidSolana() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("@peridotvault/pid-solana") as typeof import("@peridotvault/pid-solana");
  }

  private relayer(): Keypair {
    const { Keypair, fromHex } = this.pidSolana;
    const secret = this.config.getOrThrow<string>("PID_RELAYER_SECRET");
    return Keypair.fromSecretKey(fromHex(secret));
  }

  private treasury(): PublicKey {
    const { PublicKey } = this.pidSolana;
    const override = this.config.get<string>("PID_TREASURY_PUBKEY");
    return override ? new PublicKey(override) : this.relayer().publicKey;
  }

  private adapter(): SolanaAdapter {
    const { SolanaAdapter, SolanaRpc } = this.pidSolana;
    return new SolanaAdapter(new SolanaRpc(this.rpcUrl()));
  }

  /** The identity's default account + its smart-account chain row (ownership from token). */
  private async resolveSmart(identityId: string): Promise<{ accountId: string; chain: ChainAccount }> {
    const account = await this.prisma.pidAccount.findFirst({
      where: { identityId, status: "active" },
      include: { chainAccounts: true },
    });
    if (!account) throw new NotFoundException("Account not found");
    const chain = account.chainAccounts.find((c) => c.accountType === ACCOUNT_TYPE_SMART);
    if (!chain) throw new BadRequestException("Smart account not created");
    return { accountId: account.id, chain };
  }

  private async assertActivated(adapter: SolanaAdapter, address: string): Promise<void> {
    let activated = false;
    try {
      activated = await adapter.isActivated(address);
    } catch {
      // fall through to the false branch
    }
    if (!activated) throw new ConflictException("Wallet must be activated before sending");
  }

  /** relay fee = ceil(baseFee × (1 + margin)) — reimbursement for the network fee the relayer floats. */
  private async relayFeeLamports(adapter: SolanaAdapter): Promise<bigint> {
    const baseFee = await adapter.estimateWithdrawFee();
    const margin = this.marginRate();
    const total = baseFee + (baseFee * BigInt(Math.round(margin * 1000))) / 1000n;
    return total;
  }

  /** Compute the fair relay fee and share the chain time so the client signs the same expiry. */
  async quote(identityId: string): Promise<WithdrawQuote> {
    const adapter = this.adapter();
    const { chain } = await this.resolveSmart(identityId);
    await this.assertActivated(adapter, chain.address);
    const relayFeeLamports = await this.relayFeeLamports(adapter);
    const chainTime = await adapter.chainTime();
    return { relayFeeLamports: relayFeeLamports.toString(), chainTime };
  }

  async withdraw(
    identityId: string,
    dto: {
      asset: string;
      to: string;
      amount: string;
      nonce: string;
      expiry: number;
      relayFeeLamports: string;
      assertion: { id: string; signature: string; authenticatorData: string; clientDataJSON: string };
    },
  ): Promise<SponsoredWithdrawResult> {
    const adapter = this.adapter();
    const { accountId, chain } = await this.resolveSmart(identityId);
    await this.assertActivated(adapter, chain.address);

    // The asserting credential must be one of this account's active passkeys.
    const authority = await this.prisma.authority.findFirst({
      where: { accountId, credentialId: dto.assertion.id, status: "active" },
    });
    if (!authority) throw new BadRequestException("Unknown or inactive passkey");

    const amount = BigInt(dto.amount);
    const relayFee = BigInt(dto.relayFeeLamports);
    if (amount <= 0n) throw new BadRequestException("Amount must be greater than 0");

    // Stale-nonce / expired rejections happen before broadcast to avoid wasting the relay fee.
    const chainNonce = BigInt(await adapter.getNonce(accountId));
    if (BigInt(dto.nonce) !== chainNonce) {
      throw new ConflictException("Authorization is stale — please try again (a newer nonce is active)");
    }
    const chainTime = await adapter.chainTime();
    if (dto.expiry <= chainTime) throw new BadRequestException("Authorization expired — please try again");

    // The user's signed relay fee must cover the fair fee (client got it from /quote).
    const fairFee = await this.relayFeeLamports(adapter);
    if (relayFee < fairFee) {
      throw new BadRequestException("Relay fee is below the required amount — re-quote and try again");
    }

    const smart = await adapter.getBalanceOf(chain.address);
    if (smart < Number(amount) + Number(relayFee)) {
      throw new BadRequestException(`Insufficient balance — need ${amount + relayFee} lamports, have ${smart}`);
    }
    if (SmartEquals(this.treasury(), dto.to) || dto.to === chain.address) {
      throw new BadRequestException("Destination cannot be the smart account");
    }

    // Relayer float pre-check (same fail-fast as activation).
    const relayerBal = await adapter.getBalanceOf(this.relayer().publicKey.toBase58());
    const feeForTx = await adapter.estimateWithdrawFee().catch(() => 5000n);
    if (relayerBal < Number(feeForTx)) {
      await this.security.log(identityId, "withdraw.relayer_unfunded", {}, accountId);
      throw new ServiceUnavailableException(
        "Peridot's fee service is briefly unavailable. No SOL was deducted from your wallet — please try again in a moment.",
      );
    }

    const authorityCompressed = coseToCompressedSecp256r1(Buffer.from(authority.publicKey)) as unknown as Uint8Array<ArrayBufferLike>;
    const { b64urlToBytes } = this.pidSolana;
    const assertion: PasskeyAssertion = {
      credentialId: dto.assertion.id,
      signature: b64urlToBytes(dto.assertion.signature) as unknown as Uint8Array<ArrayBufferLike>,
      authenticatorData: b64urlToBytes(dto.assertion.authenticatorData) as unknown as Uint8Array<ArrayBufferLike>,
      clientDataJSON: b64urlToBytes(dto.assertion.clientDataJSON) as unknown as Uint8Array<ArrayBufferLike>,
    };

    const { PublicKey } = this.pidSolana;
    const nonce = chainNonce;
    const expiry = dto.expiry;

    let signature: string;
    if (dto.asset === "SOL") {
      signature = await adapter.sponsoredWithdrawSol(
        accountId,
        authorityCompressed,
        new PublicKey(dto.to),
        amount,
        relayFee,
        nonce,
        expiry,
        assertion,
        this.relayer(),
        this.treasury(),
      );
    } else {
      const mint = new PublicKey(dto.asset);
      const sourceAta = await adapter.tokenAta(accountId, mint);
      if (!(await adapter.hasAccount(sourceAta.toBase58()))) {
        throw new BadRequestException("Token account is not registered on this wallet yet");
      }
      signature = await adapter.sponsoredWithdrawToken(
        accountId,
        authorityCompressed,
        mint,
        new PublicKey(dto.to),
        amount,
        relayFee,
        nonce,
        expiry,
        assertion as never,
        this.relayer(),
        this.treasury(),
      );
    }

    const status = (await adapter.waitForConfirmation(signature, 8, 1000)) === "confirmed" ? "confirmed" : "pending";
    await this.security.log(identityId, "withdraw.submitted", { signature, amount: amount.toString(), asset: dto.asset }, accountId);
    return { signature, relayFeeLamports: relayFee.toString(), status };
  }
}

function SmartEquals(pub: PublicKey, address: string): boolean {
  try {
    return pub.toBase58() === address;
  } catch {
    return false;
  }
}