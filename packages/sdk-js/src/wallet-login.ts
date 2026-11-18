// External-wallet connectors for the embedded login modal and the first-party
// wallet's login screen (stage 4 of docs/plan/04-embedded-login-sdk.md).
//
// The connectors only DISCOVER an injected provider, ask for the address and
// relay a signature. Keys never leave the extension: this module receives an
// address and a signature, nothing else. No wallet SDKs are bundled — Phantom
// and MetaMask both inject their provider into the page.

export type WalletKind = "phantom" | "metamask";

export interface SolanaProvider {
  isPhantom?: boolean;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  signMessage(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array }>;
}

export interface EvmProvider {
  isMetaMask?: boolean;
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface InjectedWallets {
  phantom?: SolanaProvider;
  solana?: SolanaProvider;
  ethereum?: EvmProvider;
}

export interface WalletConnector {
  kind: WalletKind;
  label: string;
  namespace: "solana" | "evm";
  /** Default chain reference for the login challenge. */
  reference: string;
  /** Address of the connected account. */
  connect(): Promise<string>;
  /** Signature over the exact UTF-8 message: base64 (Solana) / hex (EVM). */
  signMessage(address: string, message: string): Promise<string>;
}

/** Base64 without Node's Buffer (browser + SSR-safe). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Hex-encode UTF-8 text for `personal_sign`. */
export function utf8ToHex(message: string): `0x${string}` {
  const bytes = new TextEncoder().encode(message);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `0x${hex}`;
}

function phantom(provider: SolanaProvider): WalletConnector {
  let address: string | null = null;
  return {
    kind: "phantom",
    label: "Phantom",
    namespace: "solana",
    reference: "mainnet-beta",
    async connect() {
      const res = await provider.connect();
      address = res.publicKey.toString();
      return address;
    },
    async signMessage(addr, message) {
      const { signature } = await provider.signMessage(new TextEncoder().encode(message), "utf8");
      return bytesToBase64(signature);
    },
  };
}

function metamask(provider: EvmProvider): WalletConnector {
  return {
    kind: "metamask",
    label: "MetaMask",
    namespace: "evm",
    reference: "1",
    async connect() {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const first = Array.isArray(accounts) ? accounts[0] : undefined;
      if (typeof first !== "string") throw new Error("MetaMask returned no account");
      return first;
    },
    async signMessage(addr, message) {
      // personal_sign (EIP-191): the server verifies with the same encoding.
      const signature = await provider.request({ method: "personal_sign", params: [utf8ToHex(message), addr] });
      if (typeof signature !== "string") throw new Error("MetaMask returned no signature");
      return signature;
    },
  };
}

/**
 * Wallets injected into this page, in display order. Empty when no extension
 * is installed — the modal then reports "no wallet found" instead of failing
 * on a click.
 */
export function detectWallets(injected?: InjectedWallets): WalletConnector[] {
  const source =
    injected ?? (typeof window === "undefined" ? {} : ((window as unknown as { phantom?: SolanaProvider; solana?: SolanaProvider; ethereum?: EvmProvider }) ?? {}));
  const wallets: WalletConnector[] = [];
  const solana = source.phantom ?? source.solana;
  if (solana) wallets.push(phantom(solana));
  if (source.ethereum) wallets.push(metamask(source.ethereum));
  return wallets;
}
