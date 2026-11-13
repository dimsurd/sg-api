import { defineConfig } from 'vitest/config';

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/star_generation_test';

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
