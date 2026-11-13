import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Recreate the test database and load the schema once per run. */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/star_generation_test';
  execFileSync('bash', [path.resolve('db/reset.sh')], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
