// PeridotID wallet app configuration. Override via env for different environments.

// The SDK prepends `/v1/...` paths, so baseUrl is the origin (no trailing /v1).
// Chains/RPC come from the API registry — no Solana env here.
const devHost = typeof window !== "undefined" ? window.location.hostname : "localhost";

export const API_BASE_URL = import.meta.env.VITE_API_URL ?? `http://${devHost}:3301`;
