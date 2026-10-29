// ANT-866 B1/F1: PID-key binding derivation pins (runs against the BUILT
// package). Pure shape tests, no chain: the SDK must mirror state.rs
// seed construction byte-for-byte, and distinct keys must diverge.
// Run: `node --test test/` from packages/core (pretest builds).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  vaultKeyHash,
  pidToSeed32,
  deriveTicketAddress,
  deriveTombstoneAddress,
} from "../dist/index.js";
import { PublicKey } from "@solana/web3.js";

const PROGRAM = new PublicKey("CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT");
const K0 = Buffer.from("02" + "11".repeat(32), "hex");
const K1 = Buffer.from("03" + "22".repeat(32), "hex");
const PID_HASH = pidToSeed32("b1f1@pid");

describe("ANT-866/F1 PID-key binding derivation", () => {
  it("vaultKeyHash is sha256(authority), 32 bytes, keyed", () => {
    const h = Buffer.from(vaultKeyHash(new Uint8Array(K0)));
    assert.equal(h.length, 32);
    assert.ok(h.equals(crypto.createHash("sha256").update(K0).digest()));
    assert.ok(!h.equals(crypto.createHash("sha256").update(K1).digest()));
    assert.throws(() => vaultKeyHash(new Uint8Array(32)), /33 bytes/);
  });

  it("ticket PDA binds (account_id, key): distinct keys diverge", () => {
    const a = deriveTicketAddress(new Uint8Array(PID_HASH), new Uint8Array(K0), PROGRAM).address;
    const b = deriveTicketAddress(new Uint8Array(PID_HASH), new Uint8Array(K1), PROGRAM).address;
    assert.notEqual(a.toBase58(), b.toBase58());
    // Deterministic.
    assert.equal(a.toBase58(), deriveTicketAddress(new Uint8Array(PID_HASH), new Uint8Array(K0), PROGRAM).address.toBase58());
  });

  it("tombstone PDA is pid-only (no key input)", () => {
    const a = deriveTombstoneAddress(new Uint8Array(PID_HASH), PROGRAM).address;
    const b = deriveTombstoneAddress(new Uint8Array(PID_HASH), PROGRAM).address;
    assert.equal(a.toBase58(), b.toBase58());
    // Differs from any key-bound PDA for the same pid.
    assert.notEqual(a.toBase58(), deriveTicketAddress(new Uint8Array(PID_HASH), new Uint8Array(K0), PROGRAM).address.toBase58());
  });
});
