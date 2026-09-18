import { createHmac } from "node:crypto";
import { buildStringToSign, DokuProvider, sha256Base64 } from "@peridotvault/pid-payments";

const SECRET = "SK-test-secret";
const provider = new DokuProvider({ mode: "sandbox", clientId: "BRN-0260-TEST", secretKey: SECRET });

function signedHeaders(rawBody: string) {
  const headers = {
    clientId: "BRN-0260-TEST",
    requestId: "req-1",
    requestTimestamp: "2026-09-18T00:00:00Z",
  };
  const mac = createHmac("sha256", SECRET)
    .update(
      buildStringToSign({ ...headers, requestTarget: "/v1/fiat/webhook/doku", digest: sha256Base64(rawBody) }),
    )
    .digest("base64");
  return {
    "Client-Id": headers.clientId,
    "Request-Id": headers.requestId,
    "Request-Timestamp": headers.requestTimestamp,
    Signature: `HMACSHA256=${mac}`,
  };
}

describe("DokuProvider", () => {
  it("verifies its own webhook signatures and rejects forgeries", () => {
    const rawBody = JSON.stringify({ order: { invoice_number: "PIDABC123" }, transaction: { status: "SUCCESS" } });
    const headers = signedHeaders(rawBody);
    expect(provider.verifyWebhook(headers, rawBody, "/v1/fiat/webhook/doku")).toBe(true);
    expect(provider.verifyWebhook({ ...headers, Signature: "HMACSHA256=AAAA" }, rawBody, "/v1/fiat/webhook/doku")).toBe(false);
    // Wrong path (e.g. stale DOKU_NOTIFY_URL) fails closed.
    expect(provider.verifyWebhook(headers, rawBody, "/v1/fiat/doku/notify")).toBe(false);
  });

  it("parses SUCCESS/EXPIRED/unknown statuses and rejects garbage", () => {
    expect(
      provider.parseWebhook(JSON.stringify({ order: { invoice_number: "I1" }, transaction: { status: "SUCCESS" } })),
    ).toMatchObject({ invoiceNumber: "I1", status: "paid" });
    expect(
      provider.parseWebhook(JSON.stringify({ order: { invoice_number: "I2" }, transaction: { status: "EXPIRED" } })),
    ).toMatchObject({ invoiceNumber: "I2", status: "expired" });
    expect(provider.parseWebhook(JSON.stringify({ order: { invoice_number: "I3" }, transaction: { status: "WHATEVER" } }))).toMatchObject({
      status: "failed",
    });
    expect(provider.parseWebhook("not-json")).toBeNull();
    expect(provider.parseWebhook(JSON.stringify({ no: "invoice" }))).toBeNull();
  });
});
