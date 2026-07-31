import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // Vitest stubs `.css` imports to "" by default (`css: { include: [] }`),
    // and its matcher does not exempt a `?raw` query — so tokens.test.ts would
    // assert against an empty string and pass vacuously. Scoped to this one
    // file rather than `css: true` so no other test's CSS handling changes.
    css: { include: [/tokens\.css/] },
  },
});
