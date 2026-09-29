import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The app calls the same-origin `/api/*` endpoints that the existing
// LoopCast backend exposes. In dev, proxy those calls to that backend
// (default assumed at :3000 — change the target to match your server).
// In production, just serve the built `dist/` folder from the same
// origin as the backend and no proxy is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
