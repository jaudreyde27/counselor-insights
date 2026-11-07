import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "node",
    setupFiles: ["tests/setup-env.ts"],
    // Database test files share one test database, so run files one at a time.
    fileParallelism: false,
    include: ["src/**/*.test.ts", "tests/**/*.test.ts", "infra/test/**/*.test.ts"],
  },
});
