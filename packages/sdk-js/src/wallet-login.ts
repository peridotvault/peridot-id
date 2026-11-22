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
  /** Phantom's own EVM provider at `window.phantom.ethereum`. */
  isPhantom?: boolean;
  /**
   * Brave Wallet's provider, which also sets `isMetaMask: true` for dapp
   * compatibility (wallet-docs.brave.com/ethereum/wallet-detection).
   */
  isBraveWallet?: boolean;
  /** EIP-1193 multi-provider list injected when several wallets are installed. */
  providers?: EvmProvider[];
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface InjectedWallets {
  /** Phantom injects a namespace object: the provider is `window.phantom.solana`. */
  phantom?: { solana?: SolanaProvider; ethereum?: EvmProvider };
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

/**
 * Anything a wallet throws → a real `Error`. EIP-1193 rejections arrive as plain
 * `{ code, message }` objects, and `String(obj)` renders as "[object Object]" in
 * the login screen instead of the wallet's own reason.
 */
function walletError(e: unknown, label: string): Error {
  if (e instanceof Error) return e;
  const message = (e as { message?: unknown } | null | undefined)?.message;
  return new Error(typeof message === "string" && message.trim() ? message : `${label} request failed`);
}

/** Run a provider call, normalizing whatever it rejects with. */
function fromWallet<T>(label: string, call: () => Promise<T>): Promise<T> {
  return call().catch((e: unknown) => {
    throw walletError(e, label);
  });
}

function phantom(provider: SolanaProvider): WalletConnector {
  let address: string | null = null;
  return {
    kind: "phantom",
    label: "Phantom",
    namespace: "solana",
    reference: "mainnet-beta",
    async connect() {
      const res = await fromWallet("Phantom", () => provider.connect());
      address = res.publicKey.toString();
      return address;
    },
    async signMessage(addr, message) {
      const { signature } = await fromWallet("Phantom", () =>
        provider.signMessage(new TextEncoder().encode(message), "utf8"),
      );
      return bytesToBase64(signature);
    },
  };
}

/**
 * Connect, with one recovery: when `eth_requestAccounts` fails, an origin that
 * already granted access still answers `eth_accounts` (no prompt). That covers
 * MetaMask's one-pending-permission rule (a previous attempt that never settled
 * — closed window, browser crash, double click) and any prompt that died with
 * its window. If nothing was granted, the wallet's own error is rethrown.
 */
async function accountsOrThrow(provider: EvmProvider, e: Error): Promise<string[]> {
  const known = await provider.request({ method: "eth_accounts" }).catch(() => null);
  if (Array.isArray(known) && typeof known[0] === "string") return known as string[];
  throw e;
}

function evm(kind: WalletKind, label: string, provider: EvmProvider): WalletConnector {
  // The wallet's OWN network, read once connected. A hardcoded "1" makes SIWE
  // validation fail on any chain the wallet is not on.
  let chainRef = "1";
  return {
    kind,
    label,
    namespace: "evm",
    get reference() {
      return chainRef;
    },
    async connect() {
      const accounts = await fromWallet(label, () => provider.request({ method: "eth_requestAccounts" })).catch(
        (e: Error) => accountsOrThrow(provider, e),
      );
      const first = Array.isArray(accounts) ? accounts[0] : undefined;
      if (typeof first !== "string") throw new Error(`${label} returned no account`);
      const hex = await provider.request({ method: "eth_chainId" }).catch(() => null);
      if (typeof hex === "string" && /^0x[0-9a-f]+$/i.test(hex)) chainRef = String(parseInt(hex, 16));
      return first;
    },
    async signMessage(addr, message) {
      // personal_sign (EIP-191): the server verifies with the same encoding.
      // shortcut: fixed gap between the connect popup closing and the sign popup
      // opening — Brave/Chromium has crashed on extension-popup teardown races.
      // Drop it once the wallet UI is a side panel everywhere.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const signature = await fromWallet(label, () =>
        provider.request({ method: "personal_sign", params: [utf8ToHex(message), addr] }),
      );
      if (typeof signature !== "string") throw new Error(`${label} returned no signature`);
      return signature;
    },
  };
}

/**
 * The provider that really is MetaMask. `isMetaMask` alone is not proof: Brave
 * Wallet sets it too (so sites keep working), and Phantom's proxy sets it. Both
 * answer `eth_requestAccounts` with their own UI, so labelling either one
 * "MetaMask" sends the user to the wrong wallet.
 */
function metaMaskProvider(ethereum: EvmProvider | undefined): EvmProvider | undefined {
  const list = ethereum?.providers?.length ? ethereum.providers : [ethereum];
  return list.find((p) => p?.isMetaMask === true && p.isPhantom !== true && p.isBraveWallet !== true);
}

/**
 * Wallets injected into this page, in display order. Empty when no extension
 * is installed — the modal then reports "no wallet found" instead of failing
 * on a click.
 */
export function detectWallets(injected?: InjectedWallets): WalletConnector[] {
  const source = injected ?? (typeof window === "undefined" ? {} : (window as unknown as InjectedWallets));
  const wallets: WalletConnector[] = [];
  const solana = source.phantom?.solana ?? source.solana;
  if (solana) wallets.push(phantom(solana));
  // `window.ethereum` is contested — Phantom's proxy and Brave Wallet both claim
  // `isMetaMask`, so trusting that flag alone opens the wrong wallet (Brave
  // Wallet's panel instead of MetaMask). Require a real MetaMask provider.
  const metaMask = metaMaskProvider(source.ethereum);
  if (metaMask) wallets.push(evm("metamask", "MetaMask", metaMask));
  if (source.phantom?.ethereum) wallets.push(evm("phantom", "Phantom (EVM)", source.phantom.ethereum));
  return wallets;
}

/** EIP-6963 announce payload (`eip6963:announceProvider`). */
interface AnnouncedProvider {
  info: { uuid: string; name: string; icon?: string; rdns: string };
  provider: EvmProvider;
}

const METAMASK_RDNS = "io.metamask";

/**
 * Ask every installed wallet to announce itself (EIP-6963). This is the only
 * way to reach MetaMask when another wallet owns `window.ethereum`: Brave Wallet
 * takes it by default and answers `isMetaMask: true`, but MetaMask still
 * announces its own provider object here.
 */
function announcedProviders(timeoutMs = 150): Promise<Map<string, AnnouncedProvider>> {
  if (typeof window === "undefined") return Promise.resolve(new Map());
  const found = new Map<string, AnnouncedProvider>();
  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<AnnouncedProvider>).detail;
    if (detail?.info?.rdns && detail.provider) found.set(detail.info.rdns, detail);
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return new Promise((resolve) =>
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      resolve(found);
    }, timeoutMs),
  );
}

/**
 * `detectWallets`, plus wallets that only appear over EIP-6963. Use this
 * wherever the user picks a wallet, so "MetaMask" opens MetaMask and not the
 * browser's own wallet that happens to answer on `window.ethereum`.
 */
export async function discoverWallets(injected?: InjectedWallets): Promise<WalletConnector[]> {
  const wallets = detectWallets(injected);
  const metaMask = (await announcedProviders()).get(METAMASK_RDNS);
  if (!metaMask) return wallets;
  const others = wallets.filter((wallet) => wallet.kind !== "metamask");
  // Keep Phantom (Solana) first when present; MetaMask takes the next slot.
  others.splice(Math.min(1, others.length), 0, evm("metamask", metaMask.info.name || "MetaMask", metaMask.provider));
  return others;
}
