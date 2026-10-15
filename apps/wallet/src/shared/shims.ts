import { Buffer } from "buffer";

// Browser globals the Solana libs expect at module top level (spl-token
// calls Buffer.from during its own import). This module is imported first
// in main.tsx, so it runs before any of them.
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}
