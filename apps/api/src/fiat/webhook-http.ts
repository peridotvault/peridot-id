import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";

/** Webhooks are untrusted destinations. Pin the validated DNS answer to the
 * socket, reject private/reserved addresses and never follow redirects. */
export function publicWebhookAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
  }
  // Global unicast only. IPv4-mapped, loopback, link-local and ULA are excluded.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(db8|0):/i.test(address);
}
export async function postWebhook(target: string, init: { headers: Record<string, string>; body: string }): Promise<{ ok: boolean; status: number }> {
  const url = new URL(target);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Webhook requires a public HTTPS endpoint");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const answers = await lookup(host, { all: true });
  if (!answers.length || answers.some(a => !publicWebhookAddress(a.address))) throw new Error("Webhook destination must be public");
  const chosen = answers[0];
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "POST", headers: { ...init.headers, "Content-Length": Buffer.byteLength(init.body).toString() },
      agent: false, family: chosen.family, lookup: ((_host, _options, callback) => callback(null, chosen.address, chosen.family)) as NonNullable<Parameters<typeof request>[1]>["lookup"],
      signal: AbortSignal.timeout(5000),
    }, res => {
      const status = res.statusCode ?? 0;
      res.destroy();
      resolve({ ok: status >= 200 && status < 300, status });
    });
    req.on("error", reject);
    req.end(init.body);
  });
}
