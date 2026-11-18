// Stage 4 of docs/plan/04: external-wallet connectors used by the embedded
// login modal. They only discover injected providers and relay a signature —
// keys never leave the extension, so nothing here touches key material.
// Run: pnpm --filter @peridotvault/pid-react-embed test  (builds first via pretest)
import { test } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../dist/esm/index.js");

const phantomStub = (address) => ({
  isPhantom: true,
  connect: async () => ({ publicKey: { toString: () => address } }),
  signMessage: async (bytes) => ({ signature: new Uint8Array([1, 2, 3, bytes.length]) }),
});

const metamaskStub = (address, signature = "0xabc") => ({
  isMetaMask: true,
  request: async ({ method }) => {
    if (method === "eth_requestAccounts") return [address];
    if (method === "personal_sign") return signature;
    throw new Error(`unexpected method ${method}`);
  },
});

test("no injected provider yields no connectors (modal shows install hint)", () => {
  assert.deepEqual(mod.detectWallets({}), []);
});

test("detects Phantom and MetaMask with their chain references", () => {
  const wallets = mod.detectWallets({ phantom: phantomStub("SoLaNaAddr"), ethereum: metamaskStub("0xAbC") });
  assert.deepEqual(
    wallets.map((w) => [w.kind, w.namespace, w.reference]),
    [
      ["phantom", "solana", "mainnet-beta"],
      ["metamask", "evm", "1"],
    ],
  );
});

test("Solana signature is base64 of the wallet bytes", async () => {
  const [phantom] = mod.detectWallets({ phantom: phantomStub("SoLaNaAddr") });
  const address = await phantom.connect();
  assert.equal(address, "SoLaNaAddr");
  const message = "PID|SOLANA|WALLET|v1\nnonce";
  assert.equal(await phantom.signMessage(address, message), mod.bytesToBase64(new Uint8Array([1, 2, 3, new TextEncoder().encode(message).length])));
});

test("EVM signs the exact UTF-8 message via personal_sign (EIP-191)", async () => {
  const seen = [];
  const ethereum = {
    isMetaMask: true,
    request: async ({ method, params }) => {
      seen.push([method, params]);
      return method === "eth_requestAccounts" ? ["0xAbC"] : "0xsig";
    },
  };
  const [metamask] = mod.detectWallets({ ethereum });
  const address = await metamask.connect();
  const signature = await metamask.signMessage(address, "PID|EVM|WALLET|v1 ✓");
  assert.equal(signature, "0xsig");
  const [method, params] = seen[1];
  assert.equal(method, "personal_sign");
  assert.equal(params[1], address);
  // Hex must decode back to the identical UTF-8 bytes — the server verifies these.
  assert.equal(new TextDecoder().decode(Buffer.from(params[0].slice(2), "hex")), "PID|EVM|WALLET|v1 ✓");
});

test("an address-less wallet surfaces an error instead of an empty claim", async () => {
  const [metamask] = mod.detectWallets({ ethereum: metamaskStub(undefined) });
  await assert.rejects(() => metamask.connect(), /no account/);
});

test("modal renders as a labelled dialog and distinguishes link mode", async () => {
  const React = (await import("react")).default;
  const { renderToString } = await import("react-dom/server");
  const base = { open: true, onSuccess: () => {}, onClose: () => {} };
  const login = renderToString(React.createElement(mod.PeridotLoginModal, base));
  assert.match(login, /role="dialog"/);
  assert.match(login, /aria-modal="true"/);
  assert.match(login, /Sign in with PeridotID/);
  const link = renderToString(React.createElement(mod.PeridotLoginModal, { ...base, mode: "link" }));
  assert.match(link, /Link a wallet/);
  assert.equal(renderToString(React.createElement(mod.PeridotLoginModal, { ...base, open: false })), "");
});
