/**
 * Business rules from the brief, tested through the HTTP API against a real
 * PostgreSQL database (constraints and triggers included).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { IDS, loginAs, q, resetDb, wib } from './helpers.js';

beforeEach(resetDb);
afterAll(() => pool.end());

describe('enrollment & capacity', () => {
  it('prevents duplicate enrollment', async () => {
    const s1 = await loginAs('student1');
    const res = await s1.post('/student/enrollments', { classId: IDS.class });
    expect(res.status).toBe(409);
  });

  it('never exceeds capacity, even with concurrent requests', async () => {
    // Seed: capacity 2, student1 already holds a seat -> exactly one seat left.
    const [s2, s3] = await Promise.all([loginAs('student2'), loginAs('student3')]);
    const results = await Promise.all([
      s2.post('/student/enrollments', { classId: IDS.class }),
      s3.post('/student/enrollments', { classId: IDS.class }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const [{ n }] = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM enrollments WHERE class_id = $1 AND status <> 'cancelled'`,
      [IDS.class],
    );
    expect(n).toBe(2);
  });

  it('invoices hours x the student rate, snapshotted at issue time', async () => {
    const s2 = await loginAs('student2');
    const res = await s2.post('/student/enrollments', { classId: IDS.class, hours: 10 });
    expect(res.status).toBe(201);
    expect(res.body.invoice).toMatchObject({ hours: 10, ratePerHour: 150000, amount: 1_500_000, status: 'unpaid' });

    const admin = await loginAs('admin');
    await admin.patch(`/admin/classes/${IDS.class}`, { studentRatePerHour: 200000 });
    const [inv] = await q<{ amount: number }>('SELECT amount FROM invoices WHERE id = $1', [res.body.invoice.id]);
    expect(inv!.amount).toBe(1_500_000);
  });

  it('voiding an unpaid enrollment releases the seat', async () => {
    const [s2, s3, admin] = await Promise.all([loginAs('student2'), loginAs('student3'), loginAs('admin')]);
    const enrolled = await s2.post('/student/enrollments', { classId: IDS.class });
    expect((await s3.post('/student/enrollments', { classId: IDS.class })).status).toBe(409);
    const voided = await admin.post(`/admin/invoices/${enrolled.body.invoice.id}/void`, { reason: 'No longer joining' });
    expect(voided.body.seatReleased).toBe(true);
    expect((await s3.post('/student/enrollments', { classId: IDS.class })).status).toBe(201);
  });

  it('does not let capacity drop below seats taken', async () => {
    const [s2, admin] = await Promise.all([loginAs('student2'), loginAs('admin')]);
    await s2.post('/student/enrollments', { classId: IDS.class });
    const res = await admin.patch(`/admin/classes/${IDS.class}`, { capacity: 1 });
    expect(res.status).toBe(409);
  });
});

describe('access before and after payment', () => {
  it('students only see classes they have paid for', async () => {
    const s2 = await loginAs('student2');
    const enrolled = await s2.post('/student/enrollments', { classId: IDS.class });
    expect((await s2.get('/student/classes')).body.classes).toHaveLength(0);
    expect((await s2.get(`/student/classes/${IDS.class}/schedule`)).status).toBe(404);
    expect((await s2.get(`/student/classes/${IDS.class}/logbooks`)).status).toBe(404);

    const paid = await s2.post(`/student/invoices/${enrolled.body.invoice.id}/pay`);
    expect(paid.status).toBe(200);
    expect(paid.body.lessonsJoined).toBe(2); // the two seeded upcoming lessons
    expect((await s2.get('/student/classes')).body.classes).toHaveLength(1);
    expect((await s2.get(`/student/classes/${IDS.class}/schedule`)).status).toBe(200);
  });

  it('only an admin can undo a payment, and not once hours were used', async () => {
    const s1 = await loginAs('student1');
    expect((await s1.post(`/admin/invoices/${IDS.student1Invoice}/undo-paid`, { reason: 'x' })).status).toBe(403);
    const admin = await loginAs('admin');
    const res = await admin.post(`/admin/invoices/${IDS.student1Invoice}/undo-paid`, { reason: 'Bounced transfer' });
    expect(res.status).toBe(409);
  });
});

describe('lessons', () => {
  it('rejects an end time that does not follow the start', async () => {
    const tutor = await loginAs('tutor1');
    const res = await tutor.post('/tutor/lessons', { classId: IDS.class, startsAt: wib(48), endsAt: wib(48) });
    expect(res.status).toBe(400);
  });

  it("rejects overlapping lessons for the same tutor", async () => {
    const tutor = await loginAs('tutor1');
    const ok = await tutor.post('/tutor/lessons', { classId: IDS.class, startsAt: wib(30 * 24), endsAt: wib(30 * 24 + 2) });
    expect(ok.status).toBe(201);
    const clash = await tutor.post('/tutor/lessons', {
      classId: IDS.class,
      startsAt: wib(30 * 24 + 1),
      endsAt: wib(30 * 24 + 3),
    });
    expect(clash.status).toBe(409);
  });

  it('interprets times as WIB (UTC+7)', async () => {
    const tutor = await loginAs('tutor1');
    const res = await tutor.post('/tutor/lessons', {
      classId: IDS.class,
      startsAt: '2027-03-01T16:00:00+07:00',
      endsAt: '2027-03-01T17:30:00+07:00',
    });
    const [row] = await q<{ utc: string }>(`SELECT to_char(starts_at AT TIME ZONE 'UTC', 'HH24:MI') AS utc FROM lessons WHERE id = $1`, [
      res.body.lessonId,
    ]);
    expect(row!.utc).toBe('09:00');
  });

  it('cancelling a lesson gives the reserved hours back', async () => {
    const [tutor, s1] = await Promise.all([loginAs('tutor1'), loginAs('student1')]);
    const before = (await s1.get('/student/classes')).body.classes[0];
    await tutor.post(`/tutor/lessons/${IDS.upcomingLesson}/cancel`, { reason: 'Tutor is sick' });
    const after = (await s1.get('/student/classes')).body.classes[0];
    expect(after.reservedMinutes).toBe(before.reservedMinutes - 90);
    expect(after.availableMinutes).toBe(before.availableMinutes + 90);
  });

  it('skips a student whose balance cannot cover the lesson', async () => {
    const tutor = await loginAs('tutor1');
    // student1: 12h paid, 6h used, 3h reserved -> 3h available. A 4h lesson does not fit.
    const res = await tutor.post('/tutor/lessons', { classId: IDS.class, startsAt: wib(40 * 24), endsAt: wib(40 * 24 + 4) });
    expect(res.status).toBe(201);
    expect(res.body.added).toBe(0);
    expect(res.body.skipped).toHaveLength(1);
  });
});

describe('logbooks', () => {
  it('does not accept an entry for a lesson that has not ended', async () => {
    const tutor = await loginAs('tutor1');
    const [lesson] = await q<{ month: string }>(
      `SELECT to_char(wib_month(starts_at), 'YYYY-MM') AS month FROM lessons WHERE id = $1`,
      [IDS.upcomingLesson],
    );
    const res = await tutor.put(`/tutor/classes/${IDS.class}/logbooks/${lesson!.month}/entries/${IDS.upcomingLesson}`, {
      topic: 'a',
      activities: 'b',
      tutorObservation: 'c',
      futureRecommendation: 'd',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/not ended/);
  });

  it('keeps logbooks hidden from students until approved', async () => {
    const s1 = await loginAs('student1');
    const res = await s1.get(`/student/classes/${IDS.class}/logbooks`);
    const ids = res.body.logbooks.map((l: { id: string }) => l.id);
    expect(ids).toContain(IDS.approvedLogbook);
    expect(ids).not.toContain(IDS.submittedLogbook);
  });

  it('approved logbooks are read-only', async () => {
    const tutor = await loginAs('tutor1');
    const [lb] = await q<{ month: string; lesson_id: string }>(
      `SELECT to_char(lb.month, 'YYYY-MM') AS month, le.lesson_id
         FROM logbooks lb JOIN logbook_entries le ON le.logbook_id = lb.id WHERE lb.id = $1 LIMIT 1`,
      [IDS.approvedLogbook],
    );
    const res = await tutor.put(`/tutor/classes/${IDS.class}/logbooks/${lb!.month}/entries/${lb!.lesson_id}`, {
      topic: 'changed',
      activities: 'b',
      tutorObservation: 'c',
      futureRecommendation: 'd',
    });
    expect(res.status).toBe(409);
  });

  it('only admins approve, and approving twice adds no earnings', async () => {
    const tutor = await loginAs('tutor1');
    expect((await tutor.post(`/admin/logbooks/${IDS.submittedLogbook}/approve`)).status).toBe(403);

    const admin = await loginAs('admin');
    const preview = (await admin.get(`/admin/logbooks/${IDS.submittedLogbook}`)).body.logbook.earningsPreview;
    // 2 lessons x 90 minutes at Rp100,000/h = 2 x Rp150,000
    expect(preview.lines.map((l: { amount: number }) => l.amount)).toEqual([150000, 150000]);
    expect(preview.totalAmount).toBe(300000);

    const first = await admin.post(`/admin/logbooks/${IDS.submittedLogbook}/approve`);
    expect(first.body).toMatchObject({ alreadyApproved: false, earningsRecorded: 2 });
    const second = await admin.post(`/admin/logbooks/${IDS.submittedLogbook}/approve`);
    expect(second.body).toMatchObject({ alreadyApproved: true, earningsRecorded: 0 });

    const [{ total }] = await q<{ total: number }>(
      'SELECT sum(amount)::bigint AS total FROM tutor_earnings WHERE tutor_id = $1',
      [IDS.tutor1],
    );
    expect(total).toBe(600000); // 300k from the seeded approved month + 300k now
  });

  it('request changes sends the logbook back to the tutor', async () => {
    const [admin, tutor] = await Promise.all([loginAs('admin'), loginAs('tutor1')]);
    const res = await admin.post(`/admin/logbooks/${IDS.submittedLogbook}/request-changes`, {
      comment: 'Please add the homework you set',
    });
    expect(res.body.status).toBe('changes_requested');
    const [lb] = await q<{ month: string }>(`SELECT to_char(month, 'YYYY-MM') AS month FROM logbooks WHERE id = $1`, [
      IDS.submittedLogbook,
    ]);
    const resubmit = await tutor.post(`/tutor/classes/${IDS.class}/logbooks/${lb!.month}/submit`);
    expect(resubmit.body.status).toBe('submitted');
  });
});

describe('visibility of money', () => {
  it('tutors never see student rates', async () => {
    const tutor = await loginAs('tutor1');
    const list = await tutor.get('/tutor/classes');
    const detail = await tutor.get(`/tutor/classes/${IDS.class}`);
    for (const body of [list.body, detail.body]) {
      expect(JSON.stringify(body)).not.toMatch(/studentRate|ratePerHour":150000|amount/);
    }
  });

  it('tutors only see their own classes and earnings', async () => {
    const tutor2 = await loginAs('tutor2');
    expect((await tutor2.get(`/tutor/classes/${IDS.class}`)).status).toBe(404);
    const earnings = await tutor2.get('/tutor/earnings');
    expect(earnings.body.lines).toHaveLength(0);
  });

  it('students cannot reach earnings or admin reports', async () => {
    const s1 = await loginAs('student1');
    expect((await s1.get('/tutor/earnings')).status).toBe(403);
    expect((await s1.get('/admin/reports/overview')).status).toBe(403);
  });
});

describe('money dashboard', () => {
  it('reports hours balance and class margin from one source of truth', async () => {
    const admin = await loginAs('admin');
    const res = await admin.get('/admin/reports/overview');
    expect(res.status).toBe(200);
    const s1 = res.body.balances.find((b: { studentId: string }) => b.studentId === IDS.student1);
    // 12h paid, 4 x 90min ended = 6h used, 2 x 90min upcoming = 3h reserved
    expect(s1).toMatchObject({ paidMinutes: 720, usedMinutes: 360, reservedMinutes: 180, remainingMinutes: 360 });

    // Approved month: delivered 3h x 150k = 450k, tutor cost 300k -> margin 150k.
    const approvedMonth = res.body.classFinancials.find((f: { tutorCostApproved: number }) => f.tutorCostApproved > 0);
    expect(approvedMonth).toMatchObject({ deliveredRevenue: 450000, tutorCostApproved: 300000, margin: 150000 });
  });

  it('flags unpaid invoices and lets the admin issue a new package', async () => {
    const [s2, admin] = await Promise.all([loginAs('student2'), loginAs('admin')]);
    await s2.post('/student/enrollments', { classId: IDS.class });
    const overview = (await admin.get('/admin/reports/overview')).body;
    expect(overview.kpis.unpaidCount).toBe(1);
    expect(overview.kpis.outstandingAmount).toBe(1_800_000);

    const s1Enrollment = overview.balances.find((b: { studentId: string }) => b.studentId === IDS.student1).enrollmentId;
    const pkg = await admin.post(`/admin/enrollments/${s1Enrollment}/packages`, {});
    expect(pkg.status).toBe(201);
    // A second unpaid package on the same enrollment is refused.
    expect((await admin.post(`/admin/enrollments/${s1Enrollment}/packages`, {})).status).toBe(409);
  });
});
