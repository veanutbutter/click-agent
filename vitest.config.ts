import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/src/**/*.test.ts",
      "packages/**/test/**/*.test.ts",
      "apps/**/src/**/*.test.ts",
      "apps/**/test/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/out/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
  },
});
