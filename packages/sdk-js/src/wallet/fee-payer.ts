// Fee payer management (ADR 006 §2): a client-held Ed25519 keypair that pays transaction
// fees. The secret never leaves the device's secure storage. Blast radius = fee SOL only.

import { Keypair } from "@solana/web3.js";
import { fromHex, toHex } from "@peridotvault/pid-solana";

/** Platform secret storage for the fee-payer private key (WebCrypto/keystore/Expo SecureStore). */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

const STORAGE_KEY = "peridot.feePayer.ed25519";

/**
 * Browser/JS-default secret store (localStorage). NOT secure against XSS — replace with
 * WebCrypto non-extractable or an OS keystore for production (task 010).
 */
export class InMemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
}

export class FeePayerManager {
  constructor(private readonly store: SecretStore = new InMemorySecretStore()) {}

  /** Get the device fee payer, generating + persisting it on first use. */
  async getOrCreate(): Promise<Keypair> {
    const existing = await this.store.get(STORAGE_KEY);
    if (existing) {
      const secret = fromHex(existing);
      if (secret.length !== 64) throw new Error("corrupt fee payer secret");
      return Keypair.fromSecretKey(secret);
    }
    const keypair = Keypair.generate();
    await this.store.set(STORAGE_KEY, toHex(keypair.secretKey));
    return keypair;
  }

  /** The public address — safe to register with the API (the secret stays in the store). */
  async address(): Promise<string> {
    return (await this.getOrCreate()).publicKey.toBase58();
  }
}