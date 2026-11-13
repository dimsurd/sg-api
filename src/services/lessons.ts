/**
 * Lessons. Times arrive as ISO strings with an offset (the UI sends WIB, +07:00)
 * and are stored as timestamptz. "End after start" and "no tutor overlap" are
 * enforced by DB constraints; this layer adds the workflow rules.
 */
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { many, one, pool, withTx } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { isoDateTime, uuid } from '../lib/validation.js';
import type { AuthUser } from '../middleware/auth.js';
import { audit } from './audit.js';
import { addParticipantsToLesson } from './participants.js';

export const lessonTimesSchema = z
  .object({ startsAt: isoDateTime, endsAt: isoDateTime })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), {
    message: 'End time must be after the start time',
    path: ['endsAt'],
  });
export const createLessonSchema = z.object({ classId: uuid }).and(lessonTimesSchema);
export const cancelLessonSchema = z.object({ reason: z.string().trim().min(3, 'Please give a reason').max(500) });

/** Lessons can't be added to / moved into a month whose logbook is already submitted or approved. */
async function assertMonthOpen(client: PoolClient, classId: string, startsAt: string) {
  const lb = await one<{ status: string; month: string }>(
    client,
    `SELECT status, to_char(month, 'Mon YYYY') AS month FROM logbooks
      WHERE class_id = $1 AND month = wib_month($2::timestamptz)`,
    [classId, startsAt],
  );
  if (lb && (lb.status === 'submitted' || lb.status === 'approved')) {
    throw conflict(`The ${lb.month} logbook is already ${lb.status}, so lessons in that month can't change`);
  }
}

export async function scheduleLesson(tutor: AuthUser, input: z.infer<typeof createLessonSchema>) {
  return withTx(async (client) => {
    const cls = await one<{ id: string; tutor_rate_per_hour: number; status: string }>(
      client,
      'SELECT id, tutor_rate_per_hour, status FROM classes WHERE id = $1 AND tutor_id = $2',
      [input.classId, tutor.id],
    );
    if (!cls) throw notFound('Class');
    if (cls.status !== 'active') throw conflict('This class is archived');
    await assertMonthOpen(client, cls.id, input.startsAt);

    const lesson = await one<{ id: string; class_id: string; duration_minutes: number }>(
      client,
      `INSERT INTO lessons (class_id, tutor_id, tutor_rate_per_hour, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, class_id, duration_minutes`,
      [cls.id, tutor.id, cls.tutor_rate_per_hour, input.startsAt, input.endsAt],
    );
    const participants = await addParticipantsToLesson(client, lesson!);
    return { lessonId: lesson!.id, ...participants };
  });
}

/** Reschedule an upcoming lesson; participants are recalculated for the new length. */
export async function rescheduleLesson(tutor: AuthUser, lessonId: string, input: z.infer<typeof lessonTimesSchema>) {
  return withTx(async (client) => {
    const lesson = await one<{ id: string; class_id: string; starts_at: Date; status: string }>(
      client,
      `SELECT id, class_id, starts_at, status FROM lessons WHERE id = $1 AND tutor_id = $2 FOR UPDATE`,
      [lessonId, tutor.id],
    );
    if (!lesson) throw notFound('Lesson');
    if (lesson.status !== 'scheduled') throw conflict('A cancelled lesson cannot be rescheduled');
    if (lesson.starts_at <= new Date()) throw conflict('Only upcoming lessons can be rescheduled');
    if (new Date(input.startsAt) <= new Date()) throw badRequest('The new time must be in the future');
    await assertMonthOpen(client, lesson.class_id, input.startsAt);

    await client.query('DELETE FROM lesson_participants WHERE lesson_id = $1', [lessonId]);
    const updated = await one<{ id: string; class_id: string; duration_minutes: number }>(
      client,
      `UPDATE lessons SET starts_at = $2, ends_at = $3 WHERE id = $1 RETURNING id, class_id, duration_minutes`,
      [lessonId, input.startsAt, input.endsAt],
    );
    const participants = await addParticipantsToLesson(client, updated!);
    return { lessonId, ...participants };
  });
}

/**
 * Decision: a lesson can be cancelled (by its tutor or an admin) until it ends.
 * Cancelled lessons charge no hours (balances only count scheduled lessons),
 * earn nothing and cannot get a logbook entry.
 */
export async function cancelLesson(actor: AuthUser, lessonId: string, reason: string) {
  return withTx(async (client) => {
    const lesson = await one<{ id: string; tutor_id: string; ends_at: Date; status: string }>(
      client,
      'SELECT id, tutor_id, ends_at, status FROM lessons WHERE id = $1 FOR UPDATE',
      [lessonId],
    );
    if (!lesson || (actor.role === 'tutor' && lesson.tutor_id !== actor.id)) throw notFound('Lesson');
    if (lesson.status === 'cancelled') throw conflict('This lesson is already cancelled');
    if (lesson.ends_at <= new Date()) throw conflict('A lesson that has already ended cannot be cancelled');

    await client.query(
      `UPDATE lessons SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2 WHERE id = $1`,
      [lessonId, reason],
    );
    await audit(client, { actorId: actor.id, entity: 'lesson', entityId: lessonId, action: 'cancel', after: { reason } });
    return { lessonId };
  });
}

const LESSON_SELECT = `
  SELECT l.id, l.class_id, c.name AS class_name, l.tutor_id, t.full_name AS tutor_name,
         l.starts_at, l.ends_at, l.duration_minutes, l.status, l.cancel_reason, l.cancelled_at,
         (l.status = 'scheduled' AND l.ends_at <= now()) AS has_ended,
         (SELECT count(*)::int FROM lesson_participants lp WHERE lp.lesson_id = l.id) AS participant_count,
         EXISTS (SELECT 1 FROM logbook_entries le WHERE le.lesson_id = l.id) AS has_entry
    FROM lessons l
    JOIN classes c ON c.id = l.class_id
    JOIN users t ON t.id = l.tutor_id`;

const rangeSchema = z.object({
  classId: uuid.optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});
export const lessonQuerySchema = rangeSchema;

export async function tutorLessons(tutorId: string, q: z.infer<typeof rangeSchema>) {
  return many(
    pool,
    `${LESSON_SELECT}
      WHERE c.tutor_id = $1
        AND ($2::uuid IS NULL OR l.class_id = $2::uuid)
        AND ($3::timestamptz IS NULL OR l.starts_at >= $3::timestamptz)
        AND ($4::timestamptz IS NULL OR l.starts_at <  $4::timestamptz)
      ORDER BY l.starts_at`,
    [tutorId, q.classId ?? null, q.from ?? null, q.to ?? null],
  );
}

export async function adminLessons(q: z.infer<typeof rangeSchema> & { tutorId?: string }) {
  return many(
    pool,
    `${LESSON_SELECT}
      WHERE ($1::uuid IS NULL OR l.class_id = $1::uuid)
        AND ($2::timestamptz IS NULL OR l.starts_at >= $2::timestamptz)
        AND ($3::timestamptz IS NULL OR l.starts_at <  $3::timestamptz)
        AND ($4::uuid IS NULL OR l.tutor_id = $4::uuid)
      ORDER BY l.starts_at`,
    [q.classId ?? null, q.from ?? null, q.to ?? null, q.tutorId ?? null],
  );
}

/** Student schedule for a paid class (caller checks access), flagged with their own participation. */
export async function studentSchedule(enrollmentId: string, classId: string) {
  return many(
    pool,
    `SELECT l.id, l.starts_at, l.ends_at, l.duration_minutes, l.status, l.cancel_reason,
            t.full_name AS tutor_name,
            (l.status = 'scheduled' AND l.ends_at <= now()) AS has_ended,
            EXISTS (SELECT 1 FROM lesson_participants lp
                     WHERE lp.lesson_id = l.id AND lp.enrollment_id = $2) AS is_participant
       FROM lessons l JOIN users t ON t.id = l.tutor_id
      WHERE l.class_id = $1
      ORDER BY l.starts_at`,
    [classId, enrollmentId],
  );
}
