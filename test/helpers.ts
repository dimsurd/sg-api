import { readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';

export const app = createApp();

export const IDS = {
  admin: '00000000-0000-0000-0000-000000000001',
  tutor1: '00000000-0000-0000-0000-000000000011',
  tutor2: '00000000-0000-0000-0000-000000000012',
  student1: '00000000-0000-0000-0000-000000000021',
  class: '00000000-0000-0000-0000-000000000101',
  student1Invoice: '00000000-0000-0000-0000-000000000501',
  approvedLogbook: '00000000-0000-0000-0000-000000000402',
  submittedLogbook: '00000000-0000-0000-0000-000000000401',
  upcomingLesson: '00000000-0000-0000-0000-000000000305',
};

const seedSql = readFileSync(path.resolve('db/seed.sql'), 'utf8');

/** Wipe all rows and re-run the seed (fast; keeps the schema). */
export async function resetDb() {
  await pool.query(`
    TRUNCATE audit_logs, tutor_earnings, logbook_reviews, logbook_entries, logbooks,
             lesson_participants, lessons, invoices, enrollments, classes, users CASCADE;
    ALTER SEQUENCE invoice_no_seq RESTART;
  `);
  await pool.query(seedSql);
}

type Client = 'app' | 'backoffice';

/** A logged-in supertest agent (cookie jar) for a seeded account. */
export async function loginAs(who: string, client?: Client) {
  const c: Client = client ?? (who === 'admin' ? 'backoffice' : 'app');
  const agent = request.agent(app);
  const res = await agent
    .post('/auth/login')
    .set('x-sg-client', c)
    .send({ email: `${who}@stargeneration.test`, password: 'Password123!' });
  if (res.status !== 200) throw new Error(`login ${who} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    get: (url: string) => agent.get(url).set('x-sg-client', c),
    post: (url: string, body: object = {}) => agent.post(url).set('x-sg-client', c).send(body),
    put: (url: string, body: object = {}) => agent.put(url).set('x-sg-client', c).send(body),
    patch: (url: string, body: object = {}) => agent.patch(url).set('x-sg-client', c).send(body),
  };
}

/** ISO string in WIB (+07:00) for a Date offset from now by `hours`, rounded to the hour. */
export function wib(hoursFromNow: number, plusMinutes = 0) {
  const d = new Date(Date.now() + hoursFromNow * 3_600_000);
  d.setUTCMinutes(plusMinutes, 0, 0);
  const local = new Date(d.getTime() + 7 * 3_600_000);
  return local.toISOString().replace('Z', '+07:00').replace('.000', '');
}

export async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await pool.query(sql, params)).rows as T[];
}
