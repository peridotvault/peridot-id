// Fiat-gateway failure carrier. `httpStatus === null` means no response
// arrived (network error — the operation may or may not exist at the
// gateway, so the local row must stay retryable, never terminal).
// Any non-null status is a definitive gateway answer.

export class ProviderError extends Error {
  constructor(
    readonly httpStatus: number | null,
    readonly gatewayMessage: string,
    readonly requestId?: string,
    readonly rawResponse?: unknown,
  ) {
    super(gatewayMessage);
    this.name = "ProviderError";
  }
}
