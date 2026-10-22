import { IdentityController } from "./identity.controller";
import {
  ACCESS_COOKIE,
  CLAIM_COOKIE,
  OAUTH_STATE_COOKIE,
  REFRESH_COOKIE,
  accountRefreshCookieName,
  scopeAccessCookie,
  scopeRefreshCookie,
} from "../common/cookies";

function setup() {
  const service = { deleteAccount: jest.fn(async () => undefined) };
  const config = {
    get: jest.fn((key: string, def?: string) => {
      const values: Record<string, string> = {
        COOKIE_SECURE: "true",
        COOKIE_DOMAIN: "peridot.id",
        COOKIE_SAMESITE: "lax",
        API_URL: "https://api.peridot.id",
      };
      return values[key] ?? def ?? "";
    }),
  };
  const controller = new IdentityController(service as never, config as never);
  const res = { cookie: jest.fn(), clearCookie: jest.fn() };
  return { controller, service, res };
}

describe("IdentityController.deleteMe (M5)", () => {
  it("clears wallet, scoped, per-identity, and claim cookies on account deletion", async () => {
    const { controller, service, res } = setup();
    const accountCookie = accountRefreshCookieName("ifal@pid");
    const req = {
      cookies: {
        [ACCESS_COOKIE]: "a",
        [REFRESH_COOKIE]: "r",
        [scopeAccessCookie("web")]: "sa",
        [scopeRefreshCookie("web")]: "sr",
        [accountCookie]: "ar",
        [CLAIM_COOKIE]: "ct_x",
        [OAUTH_STATE_COOKIE]: "nonce",
      },
    } as never;

    await controller.deleteMe({ pid: "ifal@pid" } as never, req, res as never);

    expect(service.deleteAccount).toHaveBeenCalledWith("ifal@pid");
    const cleared = (res.clearCookie as jest.Mock).mock.calls.map(([n]) => n);
    for (const name of [
      ACCESS_COOKIE,
      REFRESH_COOKIE,
      scopeAccessCookie("web"),
      scopeRefreshCookie("web"),
      accountCookie,
      CLAIM_COOKIE,
      // F3: the OAuth state nonce must not survive the identity.
      OAUTH_STATE_COOKIE,
    ]) {
      expect(cleared).toContain(name);
    }
  });

  it("still clears the wallet pair when no scoped or linked cookies exist", async () => {
    const { controller, service, res } = setup();

    await controller.deleteMe({ pid: "ifal@pid" } as never, { cookies: {} } as never, res as never);

    expect(service.deleteAccount).toHaveBeenCalledWith("ifal@pid");
    const cleared = (res.clearCookie as jest.Mock).mock.calls.map(([n]) => n);
    expect(cleared).toContain(ACCESS_COOKIE);
    expect(cleared).toContain(REFRESH_COOKIE);
    // Unconditional sweep: nonce + claim clears fire even with no cookies present.
    expect(cleared).toContain(OAUTH_STATE_COOKIE);
    expect(cleared).toContain(CLAIM_COOKIE);
  });
});
