// ANT-346 M9: dashboard normalizes + validates allowed origins client-side
// (server allowlist stays authoritative). Run: `node --test test/` from
// apps/dashboard.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeOriginInput } from "../src/workspace/origins.ts";

const ok = (input) => {
  const r = normalizeOriginInput(input);
  assert.ok("origin" in r, `expected origin for ${input}, got ${JSON.stringify(r)}`);
  return r.origin;
};
const err = (input) => {
  const r = normalizeOriginInput(input);
  assert.ok("error" in r, `expected error for ${input}, got ${JSON.stringify(r)}`);
  return r.error;
};

describe("normalizeOriginInput", () => {
  it("normalizes: trims, strips slashes, lowercases", () => {
    assert.equal(ok("https://mygame.dev"), "https://mygame.dev");
    assert.equal(ok("  https://MyGame.Dev/// "), "https://mygame.dev");
    assert.equal(ok("https://mygame.dev:8443"), "https://mygame.dev:8443");
  });

  it("saves the normalized form, not the raw input", () => {
    assert.equal(ok("HTTPS://MYGAME.DEV/"), "https://mygame.dev");
  });

  it("allows http for localhost / LAN dev", () => {
    assert.equal(ok("http://localhost:3000"), "http://localhost:3000");
    assert.equal(ok("http://192.168.1.20:3303"), "http://192.168.1.20:3303");
  });

  it("rejects http for public hosts", () => {
    assert.match(err("http://mygame.dev"), /https/);
  });

  it("rejects paths, queries, fragments, and missing schemes", () => {
    assert.match(err("https://mygame.dev/callback"), /just the origin/);
    assert.match(err("https://mygame.dev?x=1"), /just the origin/);
    assert.match(err("https://mygame.dev#frag"), /just the origin/);
    assert.match(err("mygame.dev"), /scheme/);
    assert.match(err("ftp://mygame.dev"), /http\(s\)/);
    assert.match(err(""), /Enter an origin/);
  });
});
