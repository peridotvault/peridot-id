// Wallet detection + connector metadata. Phantom's injected EVM proxy and Brave
// Wallet both claim `isMetaMask`, so the MetaMask row must not accept either;
// EIP-6963 announcements are how MetaMask is found when Brave Wallet owns
// `window.ethereum`. The EVM chain reference comes from the wallet, not a
// hardcoded "1".
// Run: pnpm --filter @peridotvault/pid-sdk-js test
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectWallets, discoverWallets } from "../dist/esm/index.js";

const solana = (address) => ({
  connect: async () => ({ publicKey: { toString: () => address } }),
  signMessage: async () => ({ signature: new Uint8Array([1, 2, 3]) }),
});

function evm({ isMetaMask = false, isPhantom = false, isBraveWallet = false, chainId = "0x1", address = "0xabc" } = {}) {
  return {
    isMetaMask,
    isPhantom,
    isBraveWallet,
    request: async ({ method }) => {
      if (method === "eth_requestAccounts") return [address];
      if (method === "eth_chainId") return chainId;
      return null;
    },
  };
}

test("Brave Wallet's provider is never offered as MetaMask (it sets isMetaMask too)", () => {
  const wallets = detectWallets({ ethereum: evm({ isMetaMask: true, isBraveWallet: true }) });
  assert.deepEqual(wallets.map((w) => w.label), []);
});

test("a Brave Wallet entry in the providers list is skipped in favour of real MetaMask", () => {
  const wallets = detectWallets({
    ethereum: { providers: [evm({ isMetaMask: true, isBraveWallet: true }), evm({ isMetaMask: true })] },
  });
  assert.deepEqual(wallets.map((w) => w.label), ["MetaMask"]);
});

/** A fake page: answers `eip6963:requestProvider` with the given announcements. */
function fakeWindow(announcements) {
  const win = new EventTarget();
  win.addEventListener("eip6963:requestProvider", () => {
    for (const detail of announcements) win.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  });
  return win;
}

const announceMetaMask = (provider, name = "MetaMask") => ({
  info: { uuid: "io.metamask-uuid", name, rdns: "io.metamask" },
  provider,
});

test("EIP-6963 finds MetaMask when Brave Wallet owns window.ethereum", async () => {
  const announced = evm({ isMetaMask: true });
  globalThis.window = fakeWindow([announceMetaMask(announced)]);
  try {
    const wallets = await discoverWallets({ ethereum: evm({ isMetaMask: true, isBraveWallet: true }) });
    assert.deepEqual(wallets.map((w) => w.label), ["MetaMask"]);
    assert.equal(await wallets[0].connect(), "0xabc");
  } finally {
    delete globalThis.window;
  }
});

test("an announced MetaMask replaces the injected connector instead of duplicating the row", async () => {
  const announced = evm({ isMetaMask: true, chainId: "0xa" });
  globalThis.window = fakeWindow([announceMetaMask(announced)]);
  try {
    const wallets = await discoverWallets({ ethereum: evm({ isMetaMask: true, chainId: "0x1" }), phantom: { solana: solana("So1") } });
    assert.deepEqual(wallets.map((w) => w.label), ["Phantom", "MetaMask"]);
    await wallets[1].connect();
    assert.equal(wallets[1].reference, "10"); // the announced provider drives the connector
  } finally {
    delete globalThis.window;
  }
});

test("Phantom's window.ethereum proxy is never offered as MetaMask", () => {
  const wallets = detectWallets({ ethereum: evm({ isMetaMask: true, isPhantom: true }), phantom: { solana: solana("So1") } });
  assert.deepEqual(wallets.map((w) => w.label), ["Phantom"]);
});

test("MetaMask comes from the EIP-1193 providers list, ignoring Phantom's entry", () => {
  const wallets = detectWallets({
    ethereum: { providers: [evm({ isMetaMask: true, isPhantom: true }), evm({ isMetaMask: true })] },
    phantom: { ethereum: evm({ isPhantom: true }) },
  });
  assert.deepEqual(wallets.map((w) => w.label), ["MetaMask", "Phantom (EVM)"]);
});

test("EVM reference is the wallet's own chain, read on connect", async () => {
  const wallets = detectWallets({ ethereum: { providers: [evm({ isMetaMask: true, chainId: "0x89" })] } });
  const metamask = wallets.find((w) => w.label === "MetaMask");
  assert.equal(metamask.reference, "1"); // before connect: harmless default
  await metamask.connect();
  assert.equal(metamask.reference, "137");
});

test("MetaMask signing is one EIP-191 personal_sign call with hex data", async () => {
  const calls = [];
  const provider = {
    isMetaMask: true,
    request: async (args) => {
      calls.push(args);
      if (args.method === "eth_requestAccounts") return ["0xAbC0000000000000000000000000000000000001"];
      if (args.method === "eth_chainId") return "0x1";
      if (args.method === "personal_sign") return "0xsig";
      return null;
    },
  };
  const wallet = detectWallets({ ethereum: provider }).find((w) => w.label === "MetaMask");
  await wallet.connect();
  const signature = await wallet.signMessage("0xAbC0000000000000000000000000000000000001", "hi");
  assert.equal(signature, "0xsig");
  assert.deepEqual(
    calls.map((c) => c.method),
    ["eth_requestAccounts", "eth_chainId", "personal_sign"],
  );
  assert.deepEqual(calls[2].params, ["0x6869", "0xAbC0000000000000000000000000000000000001"]);
});

test("a plain-object provider rejection keeps its message (never [object Object])", async () => {
  const wallet = detectWallets({
    ethereum: {
      isMetaMask: true,
      request: async () => Promise.reject({ code: 4001, message: "User denied transaction signature." }),
    },
  }).find((w) => w.label === "MetaMask");
  await assert.rejects(() => wallet.connect(), (e) => {
    assert.equal(e.message, "User denied transaction signature.");
    return true;
  });
});

test("a provider rejection with no message still names the wallet", async () => {
  const wallet = detectWallets({
    ethereum: { isMetaMask: true, request: async () => Promise.reject({}) },
  }).find((w) => w.label === "MetaMask");
  await assert.rejects(() => wallet.connect(), /MetaMask request failed/);
});

test("a failed connect reuses the account the origin already granted", async () => {
  const PENDING = "Request of type 'wallet_requestPermissions' already pending for origin http://localhost:3302. Please wait";
  const calls = [];
  const wallet = detectWallets({
    ethereum: {
      isMetaMask: true,
      request: async ({ method }) => {
        calls.push(method);
        if (method === "eth_requestAccounts") throw { code: -32002, message: PENDING };
        if (method === "eth_accounts") return ["0xAbC0000000000000000000000000000000000001"];
        if (method === "eth_chainId") return "0x1";
        return null;
      },
    },
  }).find((w) => w.label === "MetaMask");
  assert.equal(await wallet.connect(), "0xAbC0000000000000000000000000000000000001");
  assert.deepEqual(calls, ["eth_requestAccounts", "eth_accounts", "eth_chainId"]);
});

test("a failed connect with no granted account rethrows the wallet's own reason", async () => {
  const wallet = detectWallets({
    ethereum: {
      isMetaMask: true,
      request: async ({ method }) => {
        if (method === "eth_requestAccounts") throw { code: -32002, message: "already pending for origin" };
        if (method === "eth_accounts") return [];
        return null;
      },
    },
  }).find((w) => w.label === "MetaMask");
  await assert.rejects(() => wallet.connect(), /already pending for origin/);
});
