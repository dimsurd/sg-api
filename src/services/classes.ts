import { z } from 'zod';
import { many, one, pool, withTx } from '../db.js';
import { conflict, notFound } from '../lib/errors.js';
import { idrAmount, packageHours, uuid } from '../lib/validation.js';
import { audit } from './audit.js';

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const createClassSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().trim().max(2000).default(''),
  tutorId: uuid,
  studentRatePerHour: idrAmount,
  tutorRatePerHour: idrAmount,
  capacity: z.number().int().min(1, 'Capacity must be at least 1').max(100),
  defaultPackageHours: packageHours.default(12),
});
export const updateClassSchema = createClassSchema
  .partial()
  .extend({ status: z.enum(['active', 'archived']).optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const ADMIN_CLASS_SELECT = `
  SELECT c.id, c.name, c.description, c.status, c.capacity, c.default_package_hours,
         c.student_rate_per_hour, c.tutor_rate_per_hour, c.created_at, c.updated_at,
         c.tutor_id, t.full_name AS tutor_name,
         (SELECT count(*)::int FROM enrollments e
           WHERE e.class_id = c.id AND e.status IN ('pending_payment', 'active')) AS seats_taken,
         (SELECT count(*)::int FROM enrollments e
           WHERE e.class_id = c.id AND e.status = 'active') AS active_students
    FROM classes c JOIN users t ON t.id = c.tutor_id`;

export async function adminListClasses() {
  return many(pool, `${ADMIN_CLASS_SELECT} ORDER BY c.status, c.name`);
}

export async function adminGetClass(id: string) {
  const row = await one(pool, `${ADMIN_CLASS_SELECT} WHERE c.id = $1`, [id]);
  if (!row) throw notFound('Class');
  return row;
}

export async function adminCreateClass(actorId: string, input: z.infer<typeof createClassSchema>) {
  return withTx(async (client) => {
    const row = await one<{ id: string }>(
      client,
      `INSERT INTO classes (name, description, tutor_id, student_rate_per_hour, tutor_rate_per_hour,
                            capacity, default_package_hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        input.name,
        input.description,
        input.tutorId,
        input.studentRatePerHour,
        input.tutorRatePerHour,
        input.capacity,
        input.defaultPackageHours,
      ],
    );
    await audit(client, { actorId, entity: 'class', entityId: row!.id, action: 'create', after: input });
    return row!;
  }).then((r) => adminGetClass(r.id));
}

/**
 * Decisions enforced here:
 *  - Rates: only affect what happens next. Paid packages keep the rate on their
 *    invoice; already-scheduled lessons keep the tutor rate they were scheduled with.
 *  - Capacity: cannot drop below the seats already taken (pending + active).
 *  - Tutor: past lessons (and earnings) stay with whoever taught them; upcoming
 *    lessons move to the new tutor at the class's tutor rate. Rejected if the
 *    new tutor has a clashing lesson.
 */
export async function adminUpdateClass(actorId: string, id: string, input: z.infer<typeof updateClassSchema>) {
  await withTx(async (client) => {
    const before = await one<{
      tutor_id: string;
      capacity: number;
      tutor_rate_per_hour: number;
      student_rate_per_hour: number;
      name: string;
      status: string;
    }>(client, 'SELECT * FROM classes WHERE id = $1 FOR UPDATE', [id]);
    if (!before) throw notFound('Class');

    if (input.capacity !== undefined) {
      const seats = await one<{ n: number }>(
        client,
        `SELECT count(*)::int AS n FROM enrollments WHERE class_id = $1 AND status IN ('pending_payment', 'active')`,
        [id],
      );
      if (input.capacity < (seats?.n ?? 0)) {
        throw conflict(
          `Capacity cannot be lower than the ${seats?.n} seat(s) already taken. Void unpaid enrollments first if needed.`,
        );
      }
    }

    const tutorChanged = input.tutorId !== undefined && input.tutorId !== before.tutor_id;
    if (tutorChanged) {
      const clashes = await many<{ lesson_id: string; starts_at: Date; ends_at: Date; other_class: string }>(
        client,
        `SELECT l.id AS lesson_id, l.starts_at, l.ends_at, oc.name AS other_class
           FROM lessons l
           JOIN lessons o ON o.tutor_id = $2 AND o.status = 'scheduled'
                         AND tstzrange(o.starts_at, o.ends_at, '[)') && tstzrange(l.starts_at, l.ends_at, '[)')
           JOIN classes oc ON oc.id = o.class_id
          WHERE l.class_id = $1 AND l.status = 'scheduled' AND l.starts_at > now()`,
        [id, input.tutorId],
      );
      if (clashes.length > 0) {
        throw conflict('The new tutor already teaches at the same time as some upcoming lessons', { clashes });
      }
    }

    await client.query(
      `UPDATE classes SET
         name                  = COALESCE($2, name),
         description           = COALESCE($3, description),
         tutor_id              = COALESCE($4, tutor_id),
         student_rate_per_hour = COALESCE($5, student_rate_per_hour),
         tutor_rate_per_hour   = COALESCE($6, tutor_rate_per_hour),
         capacity              = COALESCE($7, capacity),
         default_package_hours = COALESCE($8, default_package_hours),
         status                = COALESCE($9::class_status, status)
       WHERE id = $1`,
      [
        id,
        input.name ?? null,
        input.description ?? null,
        input.tutorId ?? null,
        input.studentRatePerHour ?? null,
        input.tutorRatePerHour ?? null,
        input.capacity ?? null,
        input.defaultPackageHours ?? null,
        input.status ?? null,
      ],
    );

    if (tutorChanged) {
      await client.query(
        `UPDATE lessons l SET tutor_id = c.tutor_id, tutor_rate_per_hour = c.tutor_rate_per_hour
           FROM classes c
          WHERE c.id = l.class_id AND l.class_id = $1 AND l.status = 'scheduled' AND l.starts_at > now()`,
        [id],
      );
    }

    await audit(client, { actorId, entity: 'class', entityId: id, action: 'update', before, after: input });
  });
  return adminGetClass(id);
}

export async function adminListTutors() {
  return many(
    pool,
    `SELECT u.id, u.full_name, u.email,
            (SELECT count(*)::int FROM classes c WHERE c.tutor_id = u.id AND c.status = 'active') AS active_classes
       FROM users u WHERE u.role = 'tutor' AND u.is_active ORDER BY u.full_name`,
  );
}

// ---------------------------------------------------------------------------
// Tutor — never exposes student rates or invoice amounts.
// ---------------------------------------------------------------------------

export async function tutorListClasses(tutorId: string) {
  return many(
    pool,
    `SELECT c.id, c.name, c.description, c.status, c.capacity, c.tutor_rate_per_hour,
            (SELECT count(*)::int FROM enrollments e WHERE e.class_id = c.id AND e.status = 'active') AS active_students,
            (SELECT min(l.starts_at) FROM lessons l
              WHERE l.class_id = c.id AND l.status = 'scheduled' AND l.starts_at > now()) AS next_lesson_at
       FROM classes c
      WHERE c.tutor_id = $1
      ORDER BY c.status, c.name`,
    [tutorId],
  );
}

export async function tutorGetClass(tutorId: string, classId: string) {
  const cls = await one(
    pool,
    `SELECT c.id, c.name, c.description, c.status, c.capacity, c.tutor_rate_per_hour
       FROM classes c WHERE c.id = $1 AND c.tutor_id = $2`,
    [classId, tutorId],
  );
  if (!cls) throw notFound('Class');
  // Tutors see who is in class and whether they have hours left — not what they paid.
  const students = await many(
    pool,
    `SELECT u.id AS student_id, u.full_name, b.remaining_minutes, b.available_minutes
       FROM v_enrollment_balance b JOIN users u ON u.id = b.student_id
      WHERE b.class_id = $1 AND b.enrollment_status = 'active'
      ORDER BY u.full_name`,
    [classId],
  );
  return { ...cls, students };
}

export async function assertTutorOwnsClass(tutorId: string, classId: string) {
  const row = await one(pool, 'SELECT 1 FROM classes WHERE id = $1 AND tutor_id = $2', [classId, tutorId]);
  if (!row) throw notFound('Class');
}

// ---------------------------------------------------------------------------
// Student
// ---------------------------------------------------------------------------

/** Catalogue: active classes, with the student's own enrollment status if any. */
export async function studentCatalogue(studentId: string) {
  return many(
    pool,
    `SELECT c.id, c.name, c.description, c.capacity, c.student_rate_per_hour, c.default_package_hours,
            t.full_name AS tutor_name,
            (SELECT count(*)::int FROM enrollments e
              WHERE e.class_id = c.id AND e.status IN ('pending_payment', 'active')) AS seats_taken,
            my.id AS my_enrollment_id, my.status AS my_enrollment_status
       FROM classes c
       JOIN users t ON t.id = c.tutor_id
       LEFT JOIN enrollments my ON my.class_id = c.id AND my.student_id = $1 AND my.status <> 'cancelled'
      WHERE c.status = 'active'
      ORDER BY c.name`,
    [studentId],
  );
}

/** Rule: students only see classes they have paid for (enrollment active). */
export async function studentMyClasses(studentId: string) {
  return many(
    pool,
    `SELECT c.id, c.name, c.description, t.full_name AS tutor_name, c.default_package_hours,
            b.enrollment_id, b.paid_minutes, b.used_minutes, b.reserved_minutes,
            b.remaining_minutes, b.available_minutes,
            (SELECT min(l.starts_at) FROM lessons l
              WHERE l.class_id = c.id AND l.status = 'scheduled' AND l.starts_at > now()) AS next_lesson_at,
            EXISTS (SELECT 1 FROM invoices i WHERE i.enrollment_id = b.enrollment_id AND i.status = 'unpaid')
              AS has_unpaid_package
       FROM v_enrollment_balance b
       JOIN classes c ON c.id = b.class_id
       JOIN users t ON t.id = c.tutor_id
      WHERE b.student_id = $1 AND b.enrollment_status = 'active'
      ORDER BY c.name`,
    [studentId],
  );
}

/** Returns the student's active enrollment for a class or 404s (no leaking existence). */
export async function assertStudentPaidClass(studentId: string, classId: string) {
  const row = await one<{ id: string }>(
    pool,
    `SELECT id FROM enrollments WHERE class_id = $1 AND student_id = $2 AND status = 'active'`,
    [classId, studentId],
  );
  if (!row) throw notFound('Class');
  return row.id;
}

