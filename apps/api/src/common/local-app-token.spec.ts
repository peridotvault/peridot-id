import { createHmac } from "node:crypto";
import { verifyLocalAppToken } from "./local-app-token";

const SECRET = "test-access-secret";

/** Same HS256 shape @nestjs/jwt emits for an app access token. */
function sign(payload: Record<string, unknown>, secret = SECRET): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

const appToken = {
  sub: "live2dev@pid",
  app: "pidapp_local",
  scope: "fiat:transfer",
  iss: "peridot-id",
  aud: "pid-app",
  type: "access",
  exp: Math.floor(Date.now() / 1000) + 60,
};

describe("verifyLocalAppToken", () => {
  it("accepts a token this stack minted", () => {
    expect(verifyLocalAppToken(sign(appToken), SECRET)).toEqual({
      pid: "live2dev@pid",
      app: "pidapp_local",
      scope: "fiat:transfer",
    });
  });

  it("rejects another secret, another audience, and an expired token", () => {
    expect(verifyLocalAppToken(sign(appToken, "other-secret"), SECRET)).toBeNull();
    expect(verifyLocalAppToken(sign({ ...appToken, aud: "pid-session" }), SECRET)).toBeNull();
    expect(verifyLocalAppToken(sign({ ...appToken, exp: Math.floor(Date.now() / 1000) - 1 }), SECRET)).toBeNull();
  });
});
