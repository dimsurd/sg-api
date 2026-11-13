import { defineConfig } from 'vitest/config';

import 'dotenv/config';

/** Same server and credentials as .env's DATABASE_URL, but its own database. */
const base = process.env.DATABASE_URL ?? 'postgres://localhost:5432/star_generation';
const TEST_DB = process.env.TEST_DATABASE_URL ?? base.replace(/\/[^/?]+(\?|$)/, '/star_generation_test$1');
process.env.TEST_DATABASE_URL = TEST_DB; // global-setup reads it

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false, // tests share one database
    testTimeout: 20_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: TEST_DB,
      JWT_SECRET: 'test-secret',
      NODE_ENV: 'test',
    },
  },
});
