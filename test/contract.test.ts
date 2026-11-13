/**
 * Keeps openapi.yaml honest:
 *  1. every Express route is documented, and every documented path exists;
 *  2. real responses validate against the documented response schemas.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { pool } from '../src/db.js';
import { IDS, loginAs, q, resetDb, wib } from './helpers.js';

type Spec = {
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: unknown }> }>>;
};
const spec = parse(readFileSync(path.resolve('openapi.yaml'), 'utf8')) as Spec;

const ajv = new Ajv2020({ strict: false, allErrors: true });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
ajv.addSchema(spec, 'openapi');

const pointerEscape = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');

function validatorFor(method: string, specPath: string, status: string) {
  const response = spec.paths[specPath]?.[method]?.responses?.[status];
  if (!response) throw new Error(`${method.toUpperCase()} ${specPath} ${status} is not documented`);
  const base = response.$ref
    ? response.$ref.slice(1) // '#/components/responses/X' -> '/components/responses/X'
    : `/paths/${pointerEscape(specPath)}/${method}/responses/${status}`;
  return ajv.compile({ $ref: `openapi#${base}/content/application~1json/schema` });
}

function expectMatches(method: string, specPath: string, res: { status: number; body: unknown }) {
  const validate = validatorFor(method, specPath, String(res.status));
  const ok = validate(res.body);
  if (!ok) console.error(method, specPath, JSON.stringify(validate.errors, null, 2));
  expect(ok).toBe(true);
}

// --------------------------------------------------------------------------

describe('route coverage', () => {
  it('documents exactly the routes Express serves', () => {
    const prefixes: Record<string, string> = { 'admin.ts': '/admin', 'tutor.ts': '/tutor', 'student.ts': '/student', 'auth.ts': '/auth' };
    const served = new Set<string>();
    for (const file of readdirSync('src/routes')) {
      const prefix = prefixes[file];
      if (!prefix) continue;
      const src = readFileSync(path.join('src/routes', file), 'utf8');
      for (const m of src.matchAll(/Router\.(get|post|put|patch|delete)\('([^']+)'/g)) {
        served.add(`${m[1]!.toUpperCase()} ${prefix}${m[2]!.replace(/:(\w+)/g, '{$1}')}`);
      }
    }
    const documented = new Set<string>();
    for (const [p, ops] of Object.entries(spec.paths)) {
      for (const method of Object.keys(ops)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) documented.add(`${method.toUpperCase()} ${p}`);
      }
    }
    expect([...served].filter((r) => !documented.has(r))).toEqual([]);
    expect([...documented].filter((r) => !served.has(r))).toEqual([]);
  });
});

describe('responses match openapi.yaml', () => {
  beforeAll(resetDb);
  afterAll(() => pool.end());

  it('admin, tutor and student reads', async () => {
    const [admin, tutor, s1, s2] = await Promise.all([
      loginAs('admin'),
      loginAs('tutor1'),
      loginAs('student1'),
      loginAs('student2'),
    ]);
    // An unpaid invoice so list endpoints have every kind of row.
    const enrolled = await s2.post('/student/enrollments', { classId: IDS.class });
    expectMatches('post', '/student/enrollments', enrolled);

    const [month] = await q<{ m: string }>(`SELECT to_char(month, 'YYYY-MM') AS m FROM logbooks WHERE id = $1`, [
      IDS.submittedLogbook,
    ]);

    const reads: [ReturnType<typeof loginAs> extends Promise<infer A> ? A : never, string, string][] = [
      [admin, '/auth/me', '/auth/me'],
      [admin, '/admin/classes', '/admin/classes'],
      [admin, `/admin/classes/${IDS.class}`, '/admin/classes/{id}'],
      [admin, '/admin/tutors', '/admin/tutors'],
      [admin, '/admin/students', '/admin/students'],
      [admin, '/admin/invoices', '/admin/invoices'],
      [admin, `/admin/invoices/${IDS.student1Invoice}/history`, '/admin/invoices/{id}/history'],
      [admin, '/admin/lessons', '/admin/lessons'],
      [admin, '/admin/logbooks', '/admin/logbooks'],
      [admin, `/admin/logbooks/${IDS.submittedLogbook}`, '/admin/logbooks/{id}'],
      [admin, '/admin/earnings', '/admin/earnings'],
      [admin, '/admin/reports/overview', '/admin/reports/overview'],
      [tutor, '/tutor/classes', '/tutor/classes'],
      [tutor, `/tutor/classes/${IDS.class}`, '/tutor/classes/{id}'],
      [tutor, '/tutor/lessons', '/tutor/lessons'],
      [tutor, '/tutor/logbooks', '/tutor/logbooks'],
      [tutor, `/tutor/classes/${IDS.class}/logbooks/${month!.m}`, '/tutor/classes/{classId}/logbooks/{month}'],
      [tutor, '/tutor/earnings', '/tutor/earnings'],
      [s1, '/student/classes/available', '/student/classes/available'],
      [s1, '/student/invoices', '/student/invoices'],
      [s1, '/student/classes', '/student/classes'],
      [s1, `/student/classes/${IDS.class}/schedule`, '/student/classes/{id}/schedule'],
      [s1, `/student/classes/${IDS.class}/logbooks`, '/student/classes/{id}/logbooks'],
    ];
    for (const [who, url, specPath] of reads) {
      const res = await who.get(url);
      expect(res.status, url).toBe(200);
      expectMatches('get', specPath, res);
    }
  });

  it('writes and error bodies', async () => {
    const [admin, tutor, s3] = await Promise.all([loginAs('admin'), loginAs('tutor1'), loginAs('student3')]);

    const scheduled = await tutor.post('/tutor/lessons', { classId: IDS.class, startsAt: wib(60 * 24), endsAt: wib(60 * 24 + 1) });
    expectMatches('post', '/tutor/lessons', scheduled);

    const clash = await tutor.post('/tutor/lessons', { classId: IDS.class, startsAt: wib(60 * 24), endsAt: wib(60 * 24 + 1) });
    expect(clash.status).toBe(409);
    expectMatches('post', '/tutor/lessons', clash);

    expectMatches('post', '/tutor/lessons/{id}/cancel', await tutor.post(`/tutor/lessons/${scheduled.body.lessonId}/cancel`, { reason: 'Holiday' }));

    // Class is full (student1 + student2 from the previous test).
    const full = await s3.post('/student/enrollments', { classId: IDS.class });
    expect(full.status).toBe(409);
    expectMatches('post', '/student/enrollments', full);

    expectMatches(
      'post',
      '/admin/logbooks/{id}/request-changes',
      await admin.post(`/admin/logbooks/${IDS.submittedLogbook}/request-changes`, { comment: 'Add the homework please' }),
    );
    const [lb] = await q<{ m: string; lesson_id: string }>(
      `SELECT to_char(lb.month, 'YYYY-MM') AS m, le.lesson_id FROM logbooks lb
         JOIN logbook_entries le ON le.logbook_id = lb.id WHERE lb.id = $1 LIMIT 1`,
      [IDS.submittedLogbook],
    );
    expectMatches(
      'put',
      '/tutor/classes/{classId}/logbooks/{month}/entries/{lessonId}',
      await tutor.put(`/tutor/classes/${IDS.class}/logbooks/${lb!.m}/entries/${lb!.lesson_id}`, {
        topic: 'Pythagoras',
        activities: 'Worksheet 4 as homework',
        tutorObservation: 'Good',
        futureRecommendation: 'More practice',
      }),
    );
    expectMatches(
      'post',
      '/tutor/classes/{classId}/logbooks/{month}/submit',
      await tutor.post(`/tutor/classes/${IDS.class}/logbooks/${lb!.m}/submit`),
    );
    expectMatches('post', '/admin/logbooks/{id}/approve', await admin.post(`/admin/logbooks/${IDS.submittedLogbook}/approve`));

    const [unpaid] = await q<{ id: string; enrollment_id: string }>(`SELECT id, enrollment_id FROM invoices WHERE status = 'unpaid' LIMIT 1`);
    expectMatches('post', '/admin/invoices/{id}/mark-paid', await admin.post(`/admin/invoices/${unpaid!.id}/mark-paid`, { paymentReference: 'BCA 123' }));
    expectMatches('post', '/admin/invoices/{id}/undo-paid', await admin.post(`/admin/invoices/${unpaid!.id}/undo-paid`, { reason: 'Transfer bounced' }));
    expectMatches('post', '/admin/invoices/{id}/void', await admin.post(`/admin/invoices/${unpaid!.id}/void`, { reason: 'Student withdrew' }));

    const s1Enrollment = (await q<{ id: string }>(`SELECT id FROM enrollments WHERE student_id = $1`, [IDS.student1]))[0]!.id;
    expectMatches('post', '/admin/enrollments/{id}/packages', await admin.post(`/admin/enrollments/${s1Enrollment}/packages`));

    const created = await admin.post('/admin/classes', {
      name: 'English Group B',
      tutorId: IDS.tutor2,
      studentRatePerHour: 120000,
      tutorRatePerHour: 80000,
      capacity: 4,
    });
    expectMatches('post', '/admin/classes', created);
    expectMatches('patch', '/admin/classes/{id}', await admin.patch(`/admin/classes/${created.body.class.id}`, { capacity: 5 }));

    const badInput = await admin.post('/admin/classes', { name: '' });
    expect(badInput.status).toBe(400);
    expectMatches('post', '/admin/classes', badInput);
  });
});
