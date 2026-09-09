import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Dev server for the example client. The assistant-transport endpoint is
 * proxied same-origin to the example server (localhost:3300) — the same
 * pattern as apps/web's route handler, keeping the SSE stream on the
 * browser's origin with zero CORS configuration.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3300",
        changeOrigin: true,
      },
    },
  },
});
