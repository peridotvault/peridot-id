import { Peridot, readEmbedParams, type EmbedParams, type PeridotClient } from "@peridotvault/pid-sdk-js";

export type { EmbedParams };
export { readEmbedParams };

/**
 * Third-party embed client. No inline passkey signer: every trust-critical
 * action delegates to the PeridotID popup on our own origin (the iframe's
 * origin), so signing always runs with a visible address bar. Reads ride the
 * read-only bearer the parent hands over (set via `setBearer`).
 */
export function createEmbedClient(baseUrl: string): PeridotClient {
  return Peridot({ baseUrl, popupBaseUrl: window.location.origin });
}
