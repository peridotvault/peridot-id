/** A PidApp as returned by the API (secrets are always omitted). */
export interface PidApp {
  id: string;
  clientId: string;
  name: string;
  allowedOrigins: string[];
  isActive: boolean;
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
