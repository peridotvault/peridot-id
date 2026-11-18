// Connectors live in the framework-free SDK (`pid-sdk-js`) so the first-party
// wallet and the embedded modal share one implementation. Re-exported here so
// the embed's public surface stays unchanged.
export { detectWallets, bytesToBase64, utf8ToHex } from "@peridotvault/pid-sdk-js";
export type { WalletConnector, WalletKind, InjectedWallets } from "@peridotvault/pid-sdk-js";
