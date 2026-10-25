// Fee payer management (fee-payer model): a client-held Ed25519 keypair that pays transaction
// fees. The secret never leaves the device's secure storage. Blast radius = fee SOL only.

import { Keypair } from "@solana/web3.js";
import { fromHex, toHex } from "./bytes.js";

/** Platform secret storage for the fee-payer private key (WebCrypto/keystore/Expo SecureStore). */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

const STORAGE_KEY = "peridot.feePayer.ed25519";

/**
 * Default secret store: process memory only. The key is still extractable by
 * JS in the page (any in-page store is), but unlike localStorage it does not
 * survive reloads and is never written to disk — so a stolen profile/cache
 * dump or a later XSS can't harvest a persisted fee-payer key. Migration to a
 * WebCrypto non-extractable key (IndexedDB opaque handle) is the follow-up;
 * see LocalStorageSecretStore for why disk persistence is opt-in only.
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

/**
 * localStorage-backed store — persists the fee payer across reloads at the
 * cost of writing the raw secret to disk, readable by ANY script running on
 * the origin (XSS = fee-SOL key theft). Use ONLY behind an explicit user
 * opt-in ("remember this device"), via FeePayerManager.withLocalStorage().
 */
export class LocalStorageSecretStore implements SecretStore {
  private readonly memory = new Map<string, string>();
  private get storage(): Storage | null {
    try {
      return typeof localStorage !== "undefined" ? localStorage : null;
    } catch {
      return null;
    }
  }
  async get(key: string): Promise<string | null> {
    const fromStorage = this.storage?.getItem(key);
    if (fromStorage != null) return fromStorage;
    return this.memory.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    if (this.storage) {
      try {
        this.storage.setItem(key, value);
        return;
      } catch {
        // quota / privacy mode — fall back to memory
      }
    }
    this.memory.set(key, value);
  }
}

export class FeePayerManager {
  /**
   * Default: in-memory store (ANT-346 H2). Browser builds must NOT persist
   * the fee-payer secret to localStorage implicitly — any wallet XSS could
   * read it straight off disk. Callers that want reload persistence must
   * take the explicit opt-in path below.
   */
  constructor(store?: SecretStore) {
    this.store = store ?? new InMemorySecretStore();
  }
  private readonly store: SecretStore;

  /**
   * Explicit opt-in to disk persistence (e.g. a "remember this device"
   * checkbox). The caller owns the XSS trade-off disclosure; there is no
   * implicit path back to localStorage.
   */
  static withLocalStorage(): FeePayerManager {
    return new FeePayerManager(new LocalStorageSecretStore());
  }

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