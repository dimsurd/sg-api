/**
 * Who is charged for a lesson.
 *
 * Decision: hours are reserved when a lesson is scheduled and become "used"
 * once the lesson has ended. A student is only added to a lesson when their
 * available balance covers the FULL lesson duration; otherwise they are
 * skipped ("out of hours") until a new package is paid, at which point they
 * are added to upcoming lessons in chronological order.
 *
 * All functions expect to run inside a transaction.
 */
import type { PoolClient } from 'pg';
import { many, one } from '../db.js';

async function availableMinutes(client: PoolClient, enrollmentId: string): Promise<number> {
  const row = await one<{ available_minutes: number }>(
    client,
    'SELECT available_minutes FROM v_enrollment_balance WHERE enrollment_id = $1',
    [enrollmentId],
  );
  return row?.available_minutes ?? 0;
}

export interface SkippedStudent {
  enrollmentId: string;
  studentName: string;
  availableMinutes: number;
}

/** Charge every active enrollment that can afford a newly scheduled lesson. */
export async function addParticipantsToLesson(
  client: PoolClient,
  lesson: { id: string; class_id: string; duration_minutes: number },
): Promise<{ added: number; skipped: SkippedStudent[] }> {
  // Lock the class's active enrollments so concurrent scheduling can't double-spend hours.
  const enrollments = await many<{ id: string; full_name: string }>(
    client,
    `SELECT e.id, u.full_name
       FROM enrollments e JOIN users u ON u.id = e.student_id
      WHERE e.class_id = $1 AND e.status = 'active'
      ORDER BY e.created_at
      FOR UPDATE OF e`,
    [lesson.class_id],
  );

  let added = 0;
  const skipped: SkippedStudent[] = [];
  for (const e of enrollments) {
    const available = await availableMinutes(client, e.id);
    if (available >= lesson.duration_minutes) {
      await client.query(
        `INSERT INTO lesson_participants (lesson_id, enrollment_id, minutes_charged)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [lesson.id, e.id, lesson.duration_minutes],
      );
      added++;
    } else {
      skipped.push({ enrollmentId: e.id, studentName: e.full_name, availableMinutes: Math.max(0, available) });
    }
  }
  return { added, skipped };
}

/** After a package is paid: join upcoming lessons the student is not yet in, earliest first. */
export async function allocateUpcomingLessons(client: PoolClient, enrollmentId: string): Promise<number> {
  let available = await availableMinutes(client, enrollmentId);
  const lessons = await many<{ id: string; duration_minutes: number }>(
    client,
    `SELECT l.id, l.duration_minutes
       FROM lessons l
       JOIN enrollments e ON e.class_id = l.class_id AND e.id = $1
      WHERE l.status = 'scheduled' AND l.starts_at > now()
        AND NOT EXISTS (SELECT 1 FROM lesson_participants lp
                         WHERE lp.lesson_id = l.id AND lp.enrollment_id = $1)
      ORDER BY l.starts_at`,
    [enrollmentId],
  );
  let added = 0;
  for (const l of lessons) {
    if (available < l.duration_minutes) break; // keep chronological order fair
    await client.query(
      'INSERT INTO lesson_participants (lesson_id, enrollment_id, minutes_charged) VALUES ($1, $2, $3)',
      [l.id, enrollmentId, l.duration_minutes],
    );
    available -= l.duration_minutes;
    added++;
  }
  return added;
}

/** After hours are removed (payment undone): drop the latest upcoming lessons until the balance is >= 0. */
export async function trimUpcomingLessons(client: PoolClient, enrollmentId: string): Promise<number> {
  let available = await availableMinutes(client, enrollmentId);
  if (available >= 0) return 0;
  const lessons = await many<{ lesson_id: string; minutes_charged: number }>(
    client,
    `SELECT lp.lesson_id, lp.minutes_charged
       FROM lesson_participants lp JOIN lessons l ON l.id = lp.lesson_id
      WHERE lp.enrollment_id = $1 AND l.status = 'scheduled' AND l.starts_at > now()
      ORDER BY l.starts_at DESC`,
    [enrollmentId],
  );
  let removed = 0;
  for (const l of lessons) {
    if (available >= 0) break;
    await client.query('DELETE FROM lesson_participants WHERE lesson_id = $1 AND enrollment_id = $2', [
      l.lesson_id,
      enrollmentId,
    ]);
    available += l.minutes_charged;
    removed++;
  }
  return removed;
}
