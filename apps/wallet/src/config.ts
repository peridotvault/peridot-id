// PeridotID wallet app configuration. Override via env for different environments.
import { Platform } from "react-native";

const devHost = Platform.OS === "web" && typeof window !== "undefined" ? window.location.hostname : "localhost";

// The SDK prepends `/v1/...` paths, so baseUrl is the origin (no trailing /v1).
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? `http://${devHost}:3301`;
export const SOLANA_RPC_URL = process.env.EXPO_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
export const SOLANA_NETWORK = process.env.EXPO_PUBLIC_SOLANA_NETWORK ?? "devnet";