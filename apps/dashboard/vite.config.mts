import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 3303 },
  preview: { port: 3303 },
  // Browser polyfills for Node globals the Solana libs expect at module
  // top level (@solana/spl-token calls Buffer.from during its own import —
  // without this the app boots to a white blank page with
  // "ReferenceError: Buffer is not defined"). Runtime assignment lives in
  // src/shims.ts (imported first by main.tsx); this wires the bundler
  // side: `global` -> globalThis, `buffer` resolvable + prebundled.
  define: { global: "globalThis" },
  resolve: { alias: { buffer: "buffer" } },
  optimizeDeps: { include: ["buffer"] },
});
