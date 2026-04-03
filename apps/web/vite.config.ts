import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",   // needed when running inside Docker
    port: 5173,
    proxy: {
      // /api/* → api-gateway, stripping the /api prefix
      // In Docker: set VITE_API_TARGET=http://api-gateway:3000 via env
      // In local dev (no Docker): defaults to http://localhost:3000
      "/api": {
        target: process.env["VITE_API_TARGET"] ?? "http://localhost:3000",
        rewrite: (path) => path.replace(/^\/api/, ""),
        changeOrigin: true
      }
    }
  }
});
