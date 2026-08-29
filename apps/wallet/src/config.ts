// PeridotID wallet app configuration. Override via env for different environments.
import { Platform } from "react-native";

const devHost = Platform.OS === "web" && typeof window !== "undefined" ? window.location.hostname : "localhost";

export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? `http://${devHost}:3301/v1`;
export const SOLANA_RPC_URL = process.env.EXPO_PUBLIC_SOLANA_RPC_URL ?? "http://127.0.0.1:8899";