import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist", "**/__fixtures__/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The bin entrypoints are two-line shims around main(); running them would
      // replace the test process.
      exclude: ["src/bin/**", "src/__fixtures__/**", "src/**/*.test.ts"],
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage",
      thresholds: { statements: 100, lines: 100, branches: 100, functions: 100 }
    }
  }
});
