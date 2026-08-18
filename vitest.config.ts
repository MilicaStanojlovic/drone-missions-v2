import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // `server-only` is a marker package: its default `index.js` unconditionally
      // throws, and only becomes a no-op when a bundler resolves the `react-server`
      // export condition (which is what makes `import "server-only"` throw when a
      // Server Component's code is accidentally pulled into a client bundle, but a
      // no-op on the actual server). Next's webpack/Turbopack config recognizes that
      // condition; plain Vitest (Vite) does not, so every module under test that
      // starts with `import "server-only"` (errors.ts, logger.ts, handler.ts, ...)
      // would otherwise throw at import time regardless of environment. Since Vitest
      // always runs in a server-equivalent (Node) context here, aliasing straight to
      // the package's own no-op `empty.js` reproduces the same behavior Next's
      // bundler gives real server code.
      "server-only": path.resolve(__dirname, "./node_modules/server-only/empty.js"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
    env: {
      // Dummy, test-only value satisfying src/lib/env.ts's required
      // JWT_SECRET (>=32 bytes) so importing anything that pulls in the
      // `env` singleton doesn't fail the whole suite at module-load time.
      // Individual env.ts tests exercise fail-fast/rejection behavior via
      // loadEnv(fixture) directly, bypassing process.env entirely.
      JWT_SECRET: "vitest-test-only-jwt-secret-not-for-real-use",
    },
  },
});
