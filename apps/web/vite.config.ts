import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // host: true binds 0.0.0.0 rather than localhost, so the dev server is
  // reachable from a container or another device on the network.
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
