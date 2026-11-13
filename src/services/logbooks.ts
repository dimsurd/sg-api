/**
 * Monthly logbooks.
 *
 * Lifecycle: draft -> submitted -> (changes_requested -> submitted)* -> approved
 *  - Tutor writes one entry per ended lesson (DB trigger enforces "ended",
 *    "same class", "same WIB month", "not cancelled").
 *  - Tutor submits when every lesson in the month has ended and has an entry.
 *  - Decision: if the admin finds a problem they "request changes" with a
 *    comment; the tutor fixes and resubmits. Admins never edit tutor content.
 *  - Approve writes tutor earnings once per lesson (unique lesson_id +
 *    ON CONFLICT DO NOTHING) and is idempotent: approving again is a no-op.
 *  - Students only ever read approved logbooks (filtered in SQL).
 */
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { many, one, pool, withTx } from '../db.js';
import { conflict, notFound } from '../lib/errors.js';
import type { AuthUser } from '../middleware/auth.js';

export const entrySchema = z.object({
  topic: z.string().trim().min(1, 'Topic is required').max(200),
  activities: z.string().trim().min(1, 'Activities are required').max(4000),
  tutorObservation: z.string().trim().min(1, 'Observation is required').max(4000),
  futureRecommendation: z.string().trim().min(1, 'Recommendation is required').max(4000),
});
export const requestChangesSchema = z.object({
  comment: z.string().trim().min(5, 'Tell the tutor what to fix').max(2000),
});
export const approveSchema = z.object({ comment: z.string().trim().max(2000).optional() });

type LogbookStatus = 'draft' | 'submitted' | 'changes_requested' | 'approved';

// ---------------------------------------------------------------------------
// Shared read model
// ---------------------------------------------------------------------------

async function monthLessons(db: PoolClient | typeof pool, classId: string, month: string) {
  return many<{
    id: string;
    tutor_id: string;
    tutor_name: string;
    starts_at: Date;
    ends_at: Date;
    duration_minutes: number;
    status: string;
    has_ended: boolean;
    entry: null | {
      id: string;
      topic: string;
      activities: string;
      tutorObservation: string;
      futureRecommendation: string;
      updatedAt: string;
    };
  }>(
    db,
    `SELECT l.id, l.tutor_id, t.full_name AS tutor_name, l.starts_at, l.ends_at, l.duration_minutes, l.status,
            (l.ends_at <= now()) AS has_ended,
            CASE WHEN le.id IS NULL THEN NULL ELSE json_build_object(
              'id', le.id, 'topic', le.topic, 'activities', le.activities,
              'tutorObservation', le.tutor_observation, 'futureRecommendation', le.future_recommendation,
              'updatedAt', le.updated_at) END AS entry
       FROM lessons l
       JOIN users t ON t.id = l.tutor_id
       LEFT JOIN logbook_entries le ON le.lesson_id = l.id
      WHERE l.class_id = $1 AND wib_month(l.starts_at) = $2::date
      ORDER BY l.starts_at DESC`, // newest first
    [classId, month],
  );
}

async function reviews(logbookId: string) {
  return many(
    pool,
    `SELECT r.action, r.comment, r.created_at, u.full_name AS actor_name, u.role AS actor_role
       FROM logbook_reviews r JOIN users u ON u.id = r.actor_id
      WHERE r.logbook_id = $1 ORDER BY r.created_at`,
    [logbookId],
  );
}

/** What still blocks submission (empty array = ready). */
function submitBlockers(lessons: Awaited<ReturnType<typeof monthLessons>>): string[] {
  const active = lessons.filter((l) => l.status === 'scheduled');
  const blockers: string[] = [];
  const upcoming = active.filter((l) => !l.has_ended).length;
  const missing = active.filter((l) => l.has_ended && !l.entry).length;
  if (active.length === 0) blockers.push('There are no lessons in this month');
  if (upcoming > 0) blockers.push(`${upcoming} lesson(s) this month have not happened yet`);
  if (missing > 0) blockers.push(`${missing} ended lesson(s) still need an entry`);
  return blockers;
}

// ---------------------------------------------------------------------------
// Tutor
// ---------------------------------------------------------------------------

export async function tutorLogbookList(tutorId: string) {
  return many(
    pool,
    `WITH months AS (
       SELECT l.class_id, wib_month(l.starts_at) AS month
         FROM lessons l JOIN classes c ON c.id = l.class_id
        WHERE c.tutor_id = $1 AND l.status = 'scheduled'
       UNION
       SELECT lb.class_id, lb.month FROM logbooks lb JOIN classes c ON c.id = lb.class_id WHERE c.tutor_id = $1
     )
     SELECT m.class_id, c.name AS class_name, to_char(m.month, 'YYYY-MM') AS month,
            lb.id AS logbook_id, COALESCE(lb.status::text, 'not_started') AS status,
            (SELECT count(*)::int FROM lessons l WHERE l.class_id = m.class_id AND l.status = 'scheduled'
                AND wib_month(l.starts_at) = m.month) AS lesson_count,
            (SELECT count(*)::int FROM lessons l WHERE l.class_id = m.class_id AND l.status = 'scheduled'
                AND wib_month(l.starts_at) = m.month AND l.ends_at <= now()) AS ended_count,
            (SELECT count(*)::int FROM logbook_entries le WHERE le.logbook_id = lb.id) AS entry_count
       FROM months m
       JOIN classes c ON c.id = m.class_id
       LEFT JOIN logbooks lb ON lb.class_id = m.class_id AND lb.month = m.month
      ORDER BY m.month DESC, c.name`,
    [tutorId],
  );
}

export async function tutorLogbookMonth(tutorId: string, classId: string, month: string) {
  const cls = await one<{ id: string; name: string }>(pool, 'SELECT id, name FROM classes WHERE id = $1 AND tutor_id = $2', [
    classId,
    tutorId,
  ]);
  if (!cls) throw notFound('Class');
  const logbook = await one<{ id: string; status: LogbookStatus; submitted_at: Date | null; approved_at: Date | null }>(
    pool,
    'SELECT id, status, submitted_at, approved_at FROM logbooks WHERE class_id = $1 AND month = $2',
    [classId, month],
  );
  const lessons = await monthLessons(pool, classId, month);
  const status = logbook?.status ?? 'draft';
  const editable = status === 'draft' || status === 'changes_requested';
  return {
    class: cls,
    month: month.slice(0, 7),
    logbook: logbook ?? null,
    status,
    editable,
    lessons: lessons.map((l) => ({ ...l, can_edit: editable && l.status === 'scheduled' && l.has_ended && l.tutor_id === tutorId })),
    blockers: editable ? submitBlockers(lessons) : [],
    reviews: logbook ? await reviews(logbook.id) : [],
  };
}

async function getOrCreateLogbook(client: PoolClient, classId: string, month: string) {
  await client.query('INSERT INTO logbooks (class_id, month) VALUES ($1, $2) ON CONFLICT DO NOTHING', [classId, month]);
  return (await one<{ id: string; status: LogbookStatus }>(
    client,
    'SELECT id, status FROM logbooks WHERE class_id = $1 AND month = $2 FOR UPDATE',
    [classId, month],
  ))!;
}

function assertEditable(status: LogbookStatus) {
  if (status === 'submitted') throw conflict('This logbook is waiting for admin review and is locked');
  if (status === 'approved') throw conflict('This logbook is approved and read-only');
}

export async function upsertEntry(
  tutor: AuthUser,
  classId: string,
  month: string,
  lessonId: string,
  input: z.infer<typeof entrySchema>,
) {
  return withTx(async (client) => {
    const lesson = await one<{ class_id: string; tutor_id: string }>(
      client,
      `SELECT l.class_id, l.tutor_id FROM lessons l JOIN classes c ON c.id = l.class_id
        WHERE l.id = $1 AND l.class_id = $2 AND c.tutor_id = $3`,
      [lessonId, classId, tutor.id],
    );
    if (!lesson) throw notFound('Lesson');
    if (lesson.tutor_id !== tutor.id) throw conflict('Only the tutor who taught this lesson can write its entry');

    const logbook = await getOrCreateLogbook(client, classId, month);
    assertEditable(logbook.status);

    // Trigger validates ended / month / cancelled.
    const entry = await one(
      client,
      `INSERT INTO logbook_entries (logbook_id, lesson_id, topic, activities, tutor_observation, future_recommendation)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (lesson_id) DO UPDATE SET
         topic = EXCLUDED.topic, activities = EXCLUDED.activities,
         tutor_observation = EXCLUDED.tutor_observation, future_recommendation = EXCLUDED.future_recommendation
       RETURNING id, lesson_id, topic, activities, tutor_observation, future_recommendation, updated_at`,
      [logbook.id, lessonId, input.topic, input.activities, input.tutorObservation, input.futureRecommendation],
    );
    return entry;
  });
}

export async function submitLogbook(tutor: AuthUser, classId: string, month: string) {
  return withTx(async (client) => {
    const cls = await one(client, 'SELECT 1 FROM classes WHERE id = $1 AND tutor_id = $2', [classId, tutor.id]);
    if (!cls) throw notFound('Class');
    const logbook = await getOrCreateLogbook(client, classId, month);
    assertEditable(logbook.status);

    const blockers = submitBlockers(await monthLessons(client, classId, month));
    if (blockers.length > 0) throw conflict('This logbook is not complete yet', { blockers });

    await client.query(`UPDATE logbooks SET status = 'submitted', submitted_at = now() WHERE id = $1`, [logbook.id]);
    await client.query(`INSERT INTO logbook_reviews (logbook_id, actor_id, action) VALUES ($1, $2, 'submitted')`, [
      logbook.id,
      tutor.id,
    ]);
    return { logbookId: logbook.id, status: 'submitted' as const };
  });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/** Per-lesson earnings the tutor gets if this logbook is approved now. */
async function earningsPreview(db: PoolClient | typeof pool, logbookId: string) {
  const lines = await many<{
    lesson_id: string;
    starts_at: Date;
    tutor_id: string;
    tutor_name: string;
    minutes: number;
    rate_per_hour: number;
    amount: number;
    already_recorded: boolean;
  }>(
    db,
    `SELECT l.id AS lesson_id, l.starts_at, l.tutor_id, t.full_name AS tutor_name,
            l.duration_minutes AS minutes, l.tutor_rate_per_hour AS rate_per_hour,
            COALESCE(te.amount, idr_for_minutes(l.tutor_rate_per_hour, l.duration_minutes)) AS amount,
            (te.id IS NOT NULL) AS already_recorded
       FROM logbook_entries le
       JOIN lessons l ON l.id = le.lesson_id
       JOIN users t ON t.id = l.tutor_id
       LEFT JOIN tutor_earnings te ON te.lesson_id = l.id
      WHERE le.logbook_id = $1
      ORDER BY l.starts_at`,
    [logbookId],
  );
  return {
    lines,
    totalMinutes: lines.reduce((s, l) => s + l.minutes, 0),
    totalAmount: lines.reduce((s, l) => s + l.amount, 0),
  };
}

export async function adminLogbookList(status?: string) {
  return many(
    pool,
    `SELECT lb.id, lb.class_id, c.name AS class_name, to_char(lb.month, 'YYYY-MM') AS month, lb.status,
            lb.submitted_at, lb.approved_at, t.full_name AS tutor_name,
            (SELECT count(*)::int FROM logbook_entries le WHERE le.logbook_id = lb.id) AS entry_count,
            (SELECT COALESCE(sum(COALESCE(te.amount, idr_for_minutes(l.tutor_rate_per_hour, l.duration_minutes))), 0)
               FROM logbook_entries le JOIN lessons l ON l.id = le.lesson_id
               LEFT JOIN tutor_earnings te ON te.lesson_id = l.id
              WHERE le.logbook_id = lb.id) AS earnings_total
       FROM logbooks lb
       JOIN classes c ON c.id = lb.class_id
       JOIN users t ON t.id = c.tutor_id
      WHERE ($1::logbook_status IS NULL OR lb.status = $1::logbook_status)
      ORDER BY (lb.status = 'submitted') DESC, lb.month DESC, c.name`,
    [status ?? null],
  );
}

export async function adminLogbookDetail(logbookId: string) {
  const lb = await one<{ id: string; class_id: string; class_name: string; month: string; status: LogbookStatus }>(
    pool,
    `SELECT lb.id, lb.class_id, c.name AS class_name, to_char(lb.month, 'YYYY-MM') AS month, lb.status,
            lb.submitted_at, lb.approved_at, a.full_name AS approved_by_name
       FROM logbooks lb JOIN classes c ON c.id = lb.class_id
       LEFT JOIN users a ON a.id = lb.approved_by
      WHERE lb.id = $1`,
    [logbookId],
  );
  if (!lb) throw notFound('Logbook');
  return {
    ...lb,
    lessons: await monthLessons(pool, lb.class_id, `${lb.month}-01`),
    earningsPreview: await earningsPreview(pool, logbookId),
    reviews: await reviews(logbookId),
  };
}

export async function requestChanges(adminId: string, logbookId: string, comment: string) {
  return withTx(async (client) => {
    const lb = await one<{ status: LogbookStatus }>(client, 'SELECT status FROM logbooks WHERE id = $1 FOR UPDATE', [
      logbookId,
    ]);
    if (!lb) throw notFound('Logbook');
    if (lb.status !== 'submitted') throw conflict('Only a submitted logbook can be sent back for changes');
    await client.query(`UPDATE logbooks SET status = 'changes_requested' WHERE id = $1`, [logbookId]);
    await client.query(
      `INSERT INTO logbook_reviews (logbook_id, actor_id, action, comment) VALUES ($1, $2, 'changes_requested', $3)`,
      [logbookId, adminId, comment],
    );
    return { logbookId, status: 'changes_requested' as const };
  });
}

export async function approveLogbook(adminId: string, logbookId: string, comment?: string) {
  return withTx(async (client) => {
    const lb = await one<{ status: LogbookStatus }>(client, 'SELECT status FROM logbooks WHERE id = $1 FOR UPDATE', [
      logbookId,
    ]);
    if (!lb) throw notFound('Logbook');
    // Idempotent: approving again changes nothing and adds no earnings.
    if (lb.status === 'approved') {
      return { logbookId, status: 'approved' as const, alreadyApproved: true, earningsRecorded: 0 };
    }
    if (lb.status !== 'submitted') throw conflict('Only a submitted logbook can be approved');

    const inserted = await client.query(
      `INSERT INTO tutor_earnings (lesson_id, tutor_id, logbook_id, minutes, rate_per_hour, amount)
       SELECT l.id, l.tutor_id, $1, l.duration_minutes, l.tutor_rate_per_hour,
              idr_for_minutes(l.tutor_rate_per_hour, l.duration_minutes)
         FROM logbook_entries le JOIN lessons l ON l.id = le.lesson_id
        WHERE le.logbook_id = $1 AND l.status = 'scheduled'
       ON CONFLICT (lesson_id) DO NOTHING`,
      [logbookId],
    );
    await client.query(`UPDATE logbooks SET status = 'approved', approved_at = now(), approved_by = $2 WHERE id = $1`, [
      logbookId,
      adminId,
    ]);
    await client.query(
      `INSERT INTO logbook_reviews (logbook_id, actor_id, action, comment) VALUES ($1, $2, 'approved', $3)`,
      [logbookId, adminId, comment ?? null],
    );
    return { logbookId, status: 'approved' as const, alreadyApproved: false, earningsRecorded: inserted.rowCount ?? 0 };
  });
}

// ---------------------------------------------------------------------------
// Student — approved only, enforced in SQL.
// ---------------------------------------------------------------------------

export async function studentLogbooks(classId: string) {
  return many(
    pool,
    `SELECT lb.id, to_char(lb.month, 'YYYY-MM') AS month, lb.approved_at,
            COALESCE(json_agg(json_build_object(
              'lessonId', l.id, 'startsAt', l.starts_at, 'endsAt', l.ends_at,
              'topic', le.topic, 'activities', le.activities,
              'tutorObservation', le.tutor_observation, 'futureRecommendation', le.future_recommendation
            ) ORDER BY l.starts_at DESC) FILTER (WHERE le.id IS NOT NULL), '[]') AS entries
       FROM logbooks lb
       LEFT JOIN logbook_entries le ON le.logbook_id = lb.id
       LEFT JOIN lessons l ON l.id = le.lesson_id
      WHERE lb.class_id = $1 AND lb.status = 'approved'
      GROUP BY lb.id
      ORDER BY lb.month DESC`,
    [classId],
  );
}
