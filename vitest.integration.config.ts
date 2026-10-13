import { defineConfig } from "vitest/config";

// Integration tests run against a real Postgres 17 + pgvector.
//
//   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres \
//     npm run test:integration
//
// TEST_DATABASE_URL must be a SUPERUSER connection: global setup
// creates a fresh `wacrm_it` database, replays every migration into it
// and hands the tests an unprivileged `wacrm_app` connection.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: { "@app-messages": new URL("./messages/en.json", import.meta.url).pathname },
  },
  test: {
    environment: "node",
    include: ["src/**/*.int.test.ts"],
    globalSetup: ["./src/test/integration/global-setup.ts"],
    // One database shared by all files — run them serially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
      PUBLIC_URL: "https://crm.example.test",
    },
  },
});
