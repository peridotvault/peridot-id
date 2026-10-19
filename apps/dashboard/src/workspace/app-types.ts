/** A PidApp as returned by the API (secrets are always omitted). */
export interface PidApp {
  id: string;
  clientId: string;
  name: string;
  allowedOrigins: string[];
  isActive: boolean;
  isVerified: boolean;
  clientSecretPrefix: string | null;
  clientSecretCreatedAt: string | null;
  webhookUrl: string | null;
}

/** Per-app fee for one operation. */
export interface AppFee {
  operation: string;
  percentBps: number;
  minIdr: string;
  maxIdr: string;
  enabled: boolean;
}

/** One payment-gateway (DOKU) fee row (admin). `methodKey` is a DOKU method
 *  code, a category, or "*" (default). The list is the category catalog plus
 *  any stored extra keys. */
export interface PaymentFeeRate {
  methodKey: string;
  /** Display label (category name for catalog rows). */
  label: string;
  category: string | null;
  /** True for the fixed category catalog rows. */
  isCategory: boolean;
  percentBps: number;
  flatIdr: string;
  minIdr: string;
  maxIdr: string;
  enabled: boolean;
  updatedAt?: string | null;
}
