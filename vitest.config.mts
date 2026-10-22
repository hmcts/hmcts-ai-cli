import { defineConfig } from "vitest/config";

/**
 * The pure decision functions of CLAUDE.md's pure/IO table, and the I/O that sits beside
 * them in the same file. A wrong branch in one of these is a wrong launch, so they stay
 * fully covered; the plumbing around them does not have to be.
 */
const PURE_DECISION_MODULES = [
  "src/auth/route.ts",
  "src/claude/user-settings.ts",
  "src/container/acr.ts",
  "src/container/claude-json.ts",
  "src/container/container-env.ts",
  "src/container/dns.ts",
  "src/container/docker-args.ts",
  "src/container/host-prep.ts",
  "src/container/lock.ts",
  "src/container/mounts.ts",
  "src/container/port-watch.ts",
  "src/container/ports.ts",
  "src/container/proc-net.ts",
  "src/container/runtime-staging.ts",
  "src/container/session.ts",
  "src/sbx/kit.ts",
  "src/sbx/sbx-args.ts",
  "src/system/container.ts",
  "src/update/feed.ts",
  "src/update/package-manager.ts",
  "src/update/self-update.ts",
  "src/workspace/plugin-dirs.ts"
];

const FULL = { statements: 100, branches: 100, functions: 100, lines: 100 };

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
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
        ...Object.fromEntries(PURE_DECISION_MODULES.map((module) => [module, FULL]))
      }
    }
  }
});
