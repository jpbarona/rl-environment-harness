import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Tests must stay fast and deterministic; no timers, no network.
    testTimeout: 5000,
    retry: 0,
  },
});