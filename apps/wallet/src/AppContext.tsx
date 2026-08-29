import { createContext, useContext } from "react";
import { Peridot, type PeridotClient } from "@peridot/sdk-js";

export interface AppContextValue {
  peridot: PeridotClient;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function usePeridot(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("Peridot context missing");
  return ctx;
}