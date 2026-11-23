import type { Request, Response } from "express";
import { identityProxy } from "./identity-proxy";

function fakeReq(path: string, overrides: Partial<Request> = {}): Request {
  return {
    method: "GET",
    path,
    originalUrl: path,
    headers: { cookie: "pid_access=abc" },
    on: (_event: string, cb: (arg?: unknown) => void) => {
      if (_event === "end") queueMicrotask(() => cb());
      return undefined;
    },
    ...overrides,
  } as unknown as Request;
}

function fakeRes() {
  const out = { statusCode: 0, headers: {} as Record<string, unknown>, body: undefined as unknown };
  const res = {
    status(code: number) {
      out.statusCode = code;
      return res;
    },
    setHeader(name: string, value: unknown) {
      out.headers[name.toLowerCase()] = value;
    },
    send(body: unknown) {
      out.body = body;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
  };
  return { res: res as unknown as Response, out };
}

describe("identityProxy", () => {
  it("passes data routes through untouched", async () => {
    let nexted = false;
    const proxy = identityProxy("https://api.peridot.id", jest.fn() as unknown as typeof fetch);
    await proxy(fakeReq("/v1/chains"), fakeRes().res, () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
  });

  it("forwards identity routes to the mainnet origin and relays set-cookie + location", async () => {
    const fetchImpl = jest.fn(async () => {
      const headers = new Headers();
      headers.set("location", "https://peridot.id/?claim=1");
      headers.append("set-cookie", "pid_access=new; Domain=.peridot.id");
      return new Response("ok", { status: 302, headers });
    });
    const { res, out } = fakeRes();
    await identityProxy("https://api.peridot.id", fetchImpl as unknown as typeof fetch)(
      fakeReq("/v1/auth/google/callback"),
      res,
      () => {
        throw new Error("must not fall through");
      },
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.peridot.id/v1/auth/google/callback",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
    expect(out.statusCode).toBe(302);
    expect(out.headers.location).toBe("https://peridot.id/?claim=1");
    expect(out.headers["set-cookie"]).toEqual(["pid_access=new; Domain=.peridot.id"]);
  });

  it("fails closed when mainnet is unreachable", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const { res, out } = fakeRes();
    await identityProxy("https://api.peridot.id", fetchImpl as unknown as typeof fetch)(
      fakeReq("/v1/identity/me"),
      res,
      () => {
        throw new Error("must not fall through");
      },
    );
    expect(out.statusCode).toBe(502);
  });

  it("sends the attested client IP, not the client's own XFF chain", async () => {
    const fetchImpl = jest.fn(async () => new Response("{}", { status: 200 }));
    const { res } = fakeRes();
    await identityProxy("https://api.peridot.id", fetchImpl as unknown as typeof fetch)(
      fakeReq("/v1/auth/session", {
        ip: "203.0.113.9",
        headers: { cookie: "pid_access=abc", "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      }),
      res,
      () => {
        throw new Error("must not fall through");
      },
    );
    const headers = (fetchImpl.mock.calls[0] as unknown[])[1] as { headers: Headers; signal: unknown };
    expect(headers.headers.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(headers.signal).toBeInstanceOf(AbortSignal);
  });

  it("does nothing when not on testnet", async () => {
    const fetchImpl = jest.fn();
    let nexted = false;
    const proxy = identityProxy("https://api.peridot.id", fetchImpl as unknown as typeof fetch, "mainnet");
    await proxy(fakeReq("/v1/auth/login"), fakeRes().res, () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
