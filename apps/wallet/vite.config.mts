import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { prodApiUrlError } from "./vite.check";

export default defineConfig(({ mode }) => {
  // ANT-346 M11: fail the build loudly if a staging/prod bundle would bake
  // in a non-https API URL (Vite inlines VITE_* at build time — a http value
  // here would ship bearer-carrying traffic in the clear).
  const apiErr = prodApiUrlError(process.env.VITE_API_URL, mode);
  if (apiErr) throw new Error(`[ANT-346 M11] ${apiErr}`);
  return {
    plugins: [react(), tailwindcss()],
    server: { port: 3302 },
    preview: { port: 3302 },
  // Browser polyfills for Node globals the Solana libs expect at module
  // top level (@solana/spl-token calls Buffer.from during its own import —
  // without this the app boots to a white blank page with
  // "ReferenceError: Buffer is not defined"). Runtime assignment lives in
  // src/shared/shims.ts (imported first by main.tsx); this wires the
  // bundler side: `global` -> globalThis, `buffer` resolvable + prebundled.
  define: { global: "globalThis" },
  resolve: { alias: { buffer: "buffer" } },
  optimizeDeps: { include: ["buffer"] },
  };
});
