import { newOAuthNonce, oauthStateSecret, signOAuthState, verifyOAuthState } from "./oauth-state";

const SECRET = "test-oauth-state-secret";
const OTHER_SECRET = "test-oauth-state-secret-other";

function get(key: string, def?: string): unknown {
  if (key === "JWT_ACCESS_SECRET") return SECRET;
  return def ?? "";
}

describe("oauth-state (M3)", () => {
  it("round-trips a signed state against its nonce", () => {
    const nonce = newOAuthNonce();
    const state = signOAuthState({ returnTo: "https://live2dev.com/auth/callback", clientId: "pidapp_abc" }, nonce, SECRET);
    expect(verifyOAuthState(state, nonce, SECRET)).toEqual({
      returnTo: "https://live2dev.com/auth/callback",
      clientId: "pidapp_abc",
    });
  });

  it("round-trips the PKCE challenge inside the signed envelope (M5)", () => {
    const nonce = newOAuthNonce();
    const state = signOAuthState(
      { returnTo: "https://mygame.dev/callback", clientId: "pidapp_abc", codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" },
      nonce,
      SECRET,
    );
    expect(verifyOAuthState(state, nonce, SECRET)).toEqual({
      returnTo: "https://mygame.dev/callback",
      clientId: "pidapp_abc",
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    });
  });

  it("rejects a nonce mismatch (foreign browser replay)", () => {
    const state = signOAuthState({ returnTo: "https://live2dev.com/" }, newOAuthNonce(), SECRET);
    expect(verifyOAuthState(state, newOAuthNonce(), SECRET)).toBeNull();
  });

  it("rejects a tampered payload (signature mismatch)", () => {
    const nonce = newOAuthNonce();
    const state = signOAuthState({ returnTo: "https://live2dev.com/" }, nonce, SECRET);
    const [raw, sig] = state.split(".");
    const body = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    body.r = "https://evil.com/";
    const forged = `${Buffer.from(JSON.stringify(body), "utf8").toString("base64url")}.${sig}`;
    expect(verifyOAuthState(forged, nonce, SECRET)).toBeNull();
  });

  it("rejects a state signed with a different secret", () => {
    const nonce = newOAuthNonce();
    const state = signOAuthState({ returnTo: "https://live2dev.com/" }, nonce, OTHER_SECRET);
    expect(verifyOAuthState(state, nonce, SECRET)).toBeNull();
  });

  it("rejects legacy unsigned states and missing inputs", () => {
    const nonce = newOAuthNonce();
    // Plain returnTo / legacy base64url envelope: no signature segment.
    expect(verifyOAuthState("https://live2dev.com/", nonce, SECRET)).toBeNull();
    expect(verifyOAuthState(Buffer.from("https://live2dev.com/").toString("base64url"), nonce, SECRET)).toBeNull();
    expect(verifyOAuthState(undefined, nonce, SECRET)).toBeNull();
    expect(verifyOAuthState(signOAuthState({ returnTo: "https://live2dev.com/" }, nonce, SECRET), undefined, SECRET)).toBeNull();
  });

  it("rejects expired states (10-min TTL)", () => {
    const nonce = newOAuthNonce();
    const state = signOAuthState({ returnTo: "https://live2dev.com/" }, nonce, SECRET, Date.now() - 11 * 60 * 1000);
    expect(verifyOAuthState(state, nonce, SECRET)).toBeNull();
  });

  it("prefers the dedicated secret, otherwise derives an isolated key via HKDF (F1)", () => {
    expect(oauthStateSecret((k, d) => (k === "OAUTH_STATE_SECRET" ? "dedicated" : get(k, d)))).toBe("dedicated");
    const derived = oauthStateSecret(get);
    // Domain-separated from the JWT master: deterministic, but never the master itself.
    expect(derived).toBe(oauthStateSecret(get));
    expect(derived).not.toBe(SECRET);
    expect(Buffer.from(derived, "base64url")).toHaveLength(32);
    expect(() => oauthStateSecret(() => "")).toThrow(/not configured/);
  });

  it("signs and verifies with the derived key (F1)", () => {
    const derived = oauthStateSecret(get);
    const nonce = newOAuthNonce();
    const state = signOAuthState({ returnTo: "https://live2dev.com/" }, nonce, derived);
    expect(verifyOAuthState(state, nonce, derived)).toEqual({ returnTo: "https://live2dev.com/" });
    // The raw JWT secret must NOT verify states signed with the derived key.
    expect(verifyOAuthState(state, nonce, SECRET)).toBeNull();
  });
});
