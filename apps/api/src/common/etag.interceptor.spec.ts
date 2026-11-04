// ETag/304 behaviour for GET reads (bandwidth + no re-serialization).
import { StreamableFile } from "@nestjs/common";
import { firstValueFrom, of } from "rxjs";
import { EtagInterceptor, weakEtag } from "./etag.interceptor";

class FakeRes {
  statusCode = 200;
  headers: Record<string, string> = {};
  setHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  getHeader(name: string) {
    return this.headers[name];
  }
  status(code: number) {
    this.statusCode = code;
    return this;
  }
}

function run(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  res?: FakeRes;
  statusCode?: number;
}) {
  const res = opts.res ?? new FakeRes();
  if (opts.statusCode) res.statusCode = opts.statusCode;
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ method: opts.method ?? "GET", url: opts.url ?? "/v1/identity/me", headers: opts.headers ?? {} }),
      getResponse: () => res,
    }),
  } as never;
  const result = new EtagInterceptor().intercept(context, { handle: () => of(opts.body ?? { pid: "ifal@pid" }) });
  return { res, result };
}

it("weakEtag is stable and body-dependent", () => {
  expect(weakEtag({ a: 1 })).toBe(weakEtag({ a: 1 }));
  expect(weakEtag({ a: 1 })).not.toBe(weakEtag({ a: 2 }));
  expect(weakEtag({ a: 1 }).startsWith('W/"')).toBe(true);
});

it("GET gets an ETag and private revalidation headers", async () => {
  const { res, result } = run({});
  await firstValueFrom(result);
  expect(res.headers.ETag?.startsWith('W/"')).toBe(true);
  expect(res.headers["Cache-Control"]).toBe("private, no-cache");
  expect(res.headers.Vary).toBe("Cookie, Authorization");
});

it("matching If-None-Match answers 304 with no body", async () => {
  const tag = weakEtag({ pid: "ifal@pid" });
  const { res, result } = run({ headers: { "if-none-match": tag } });
  const body = await firstValueFrom(result);
  expect(res.statusCode).toBe(304);
  expect(body).toBeUndefined();
});

it("non-matching If-None-Match still returns the body", async () => {
  const { res, result } = run({ headers: { "if-none-match": 'W/"other"' } });
  const body = await firstValueFrom(result);
  expect(body).toEqual({ pid: "ifal@pid" });
  expect(res.statusCode).toBe(200);
});

it("mutations are never touched", async () => {
  const { res, result } = run({ method: "POST" });
  await firstValueFrom(result);
  expect(res.headers.ETag).toBeUndefined();
  expect(res.headers["Cache-Control"]).toBeUndefined();
});

it("a route-set Cache-Control (public registry) is preserved", async () => {
  const res = new FakeRes();
  res.headers["Cache-Control"] = "public, max-age=60";
  const { result } = run({ url: "/v1/env", res });
  await firstValueFrom(result);
  expect(res.headers["Cache-Control"]).toBe("public, max-age=60");
  expect(res.headers.ETag).toBeDefined();
});

it("cookie ceremonies and binary bodies are skipped", async () => {
  const redirect = run({ url: "/v1/auth/google/callback?code=x" });
  await firstValueFrom(redirect.result);
  expect(redirect.res.headers.ETag).toBeUndefined();

  const binary = run({ body: Buffer.from("png") });
  await firstValueFrom(binary.result);
  expect(binary.res.headers.ETag).toBeUndefined();

  const stream = run({ body: new StreamableFile(Buffer.from("png")) });
  await firstValueFrom(stream.result);
  expect(stream.res.headers.ETag).toBeUndefined();
});

it("non-200 responses (201/404) are not tagged", async () => {
  const { res, result } = run({ statusCode: 201 });
  await firstValueFrom(result);
  expect(res.headers.ETag).toBeUndefined();
});
