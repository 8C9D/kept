/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev server's origin is the one the API's dev-default CORS grant
// names (server/src/index.ts); pinning the port keeps the pair honest -
// Vite would otherwise silently move to 5174 when 5173 is taken, and every
// API call would fail with a CORS error that looks like a server bug.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
