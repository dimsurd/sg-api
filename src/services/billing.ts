/**
 * Enrollments and package invoices.
 *
 * Decisions enforced here:
 *  - Invoice amount = hours x the class's student rate at the moment the
 *    package is issued (snapshotted on the invoice).
 *  - Enrolling reserves a seat immediately (pending_payment). Capacity counts
 *    pending + active seats, checked under a row lock on the class.
 *  - A package becomes Paid either via the student's simulated "Pay" button or
 *    by an admin recording a bank-transfer reference.
 *  - Only an admin can undo a payment, and only while none of that package's
 *    hours have been used. Every money action is written to audit_logs.
 *  - Voiding the only (unpaid) package of an enrollment releases the seat.
 */
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { many, one, pool, withTx } from '../db.js';
import { conflict, notFound } from '../lib/errors.js';
import { packageHours } from '../lib/validation.js';
import type { AuthUser } from '../middleware/auth.js';
import { audit } from './audit.js';
import { allocateUpcomingLessons, trimUpcomingLessons } from './participants.js';

export const packageSchema = z.object({ hours: packageHours.optional() });
export const markPaidSchema = z.object({
  paymentReference: z.string().trim().min(3, 'Add the transfer reference').max(120),
});
export const reasonSchema = z.object({ reason: z.string().trim().min(3, 'Please give a reason').max(500) });

interface InvoiceRow {
  id: string;
  invoice_no: string;
  enrollment_id: string;
  hours: number;
  rate_per_hour: number;
  amount: number;
  status: 'unpaid' | 'paid' | 'void';
  paid_at: Date | null;
  payment_reference: string | null;
}

async function issuePackage(client: PoolClient, enrollmentId: string, classId: string, hours?: number) {
  const cls = await one<{ student_rate_per_hour: number; default_package_hours: number }>(
    client,
    'SELECT student_rate_per_hour, default_package_hours FROM classes WHERE id = $1',
    [classId],
  );
  try {
    return await one<InvoiceRow>(
      client,
      `INSERT INTO invoices (enrollment_id, hours, rate_per_hour) VALUES ($1, $2, $3) RETURNING *`,
      [enrollmentId, hours ?? cls!.default_package_hours, cls!.student_rate_per_hour],
    );
  } catch (err) {
    if ((err as { constraint?: string }).constraint === 'invoices_one_unpaid_per_enrollment') {
      throw conflict('There is already an unpaid package for this class. Pay or void it first.');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Enroll
// ---------------------------------------------------------------------------

export async function enroll(studentId: string, classId: string, hours?: number) {
  return withTx(async (client) => {
    // Row lock serialises concurrent enrollments into the same class.
    const cls = await one<{ id: string; capacity: number; status: string }>(
      client,
      'SELECT id, capacity, status FROM classes WHERE id = $1 FOR UPDATE',
      [classId],
    );
    if (!cls || cls.status !== 'active') throw notFound('Class');

    const existing = await one(
      client,
      `SELECT 1 FROM enrollments WHERE class_id = $1 AND student_id = $2 AND status <> 'cancelled'`,
      [classId, studentId],
    );
    if (existing) throw conflict('You are already enrolled in this class');

    const seats = await one<{ n: number }>(
      client,
      `SELECT count(*)::int AS n FROM enrollments WHERE class_id = $1 AND status IN ('pending_payment', 'active')`,
      [classId],
    );
    if ((seats?.n ?? 0) >= cls.capacity) throw conflict('This class is full');

    const enrollment = await one<{ id: string }>(
      client,
      `INSERT INTO enrollments (class_id, student_id) VALUES ($1, $2) RETURNING id`,
      [classId, studentId],
    );
    const invoice = await issuePackage(client, enrollment!.id, classId, hours);
    return { enrollmentId: enrollment!.id, invoice };
  });
}

/** A further package on an existing enrollment (student "Buy package" / admin "Issue package invoice"). */
export async function buyPackage(actor: AuthUser, enrollmentId: string, hours?: number) {
  return withTx(async (client) => {
    const e = await one<{ id: string; class_id: string; student_id: string; status: string }>(
      client,
      'SELECT id, class_id, student_id, status FROM enrollments WHERE id = $1 FOR UPDATE',
      [enrollmentId],
    );
    if (!e || (actor.role === 'student' && e.student_id !== actor.id)) throw notFound('Enrollment');
    if (e.status === 'cancelled') throw conflict('This enrollment was cancelled. Enroll again instead.');
    const invoice = await issuePackage(client, e.id, e.class_id, hours);
    if (actor.role === 'admin') {
      await audit(client, { actorId: actor.id, entity: 'invoice', entityId: invoice!.id, action: 'issue_package', after: invoice });
    }
    return invoice;
  });
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

async function lockInvoice(client: PoolClient, invoiceId: string) {
  const inv = await one<InvoiceRow & { student_id: string; enrollment_status: string }>(
    client,
    `SELECT i.*, e.student_id, e.status AS enrollment_status
       FROM invoices i JOIN enrollments e ON e.id = i.enrollment_id
      WHERE i.id = $1
      FOR UPDATE OF i, e`,
    [invoiceId],
  );
  if (!inv) throw notFound('Invoice');
  return inv;
}

export async function markPaid(actor: AuthUser, invoiceId: string, paymentReference: string) {
  return withTx(async (client) => {
    const inv = await lockInvoice(client, invoiceId);
    if (actor.role === 'student' && inv.student_id !== actor.id) throw notFound('Invoice');
    if (inv.status === 'paid') throw conflict('This invoice is already paid');
    if (inv.status === 'void') throw conflict('This invoice was voided');

    await client.query(
      `UPDATE invoices SET status = 'paid', paid_at = now(), marked_paid_by = $2, payment_reference = $3 WHERE id = $1`,
      [invoiceId, actor.id, paymentReference],
    );
    await client.query(`UPDATE enrollments SET status = 'active' WHERE id = $1 AND status = 'pending_payment'`, [
      inv.enrollment_id,
    ]);
    const lessonsJoined = await allocateUpcomingLessons(client, inv.enrollment_id);
    await audit(client, {
      actorId: actor.id,
      entity: 'invoice',
      entityId: invoiceId,
      action: 'mark_paid',
      before: { status: inv.status },
      after: { status: 'paid', paymentReference, lessonsJoined },
    });
    return { invoiceId, lessonsJoined };
  });
}

export async function undoPaid(actorId: string, invoiceId: string, reason: string) {
  return withTx(async (client) => {
    const inv = await lockInvoice(client, invoiceId);
    if (inv.status !== 'paid') throw conflict('Only a paid invoice can be reverted');

    const bal = await one<{ paid_minutes: number; used_minutes: number; awaiting_minutes: number }>(
      client,
      'SELECT paid_minutes, used_minutes, awaiting_minutes FROM v_enrollment_balance WHERE enrollment_id = $1',
      [inv.enrollment_id],
    );
    // Lessons that took place but aren't logged yet still count as hours spent.
    if (bal!.paid_minutes - inv.hours * 60 < bal!.used_minutes + bal!.awaiting_minutes) {
      throw conflict("Some of this package's hours were already used in lessons, so the payment can't be undone");
    }

    await client.query(
      `UPDATE invoices SET status = 'unpaid', paid_at = NULL, marked_paid_by = NULL, payment_reference = NULL
        WHERE id = $1`,
      [invoiceId],
    );
    const lessonsDropped = await trimUpcomingLessons(client, inv.enrollment_id);
    // No paid package left -> back to pending_payment (the seat stays held by this unpaid invoice).
    await client.query(
      `UPDATE enrollments e SET status = 'pending_payment'
        WHERE e.id = $1 AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.enrollment_id = e.id AND i.status = 'paid')`,
      [inv.enrollment_id],
    );
    await audit(client, {
      actorId,
      entity: 'invoice',
      entityId: invoiceId,
      action: 'undo_paid',
      before: { status: 'paid', paymentReference: inv.payment_reference },
      after: { status: 'unpaid', reason, lessonsDropped },
    });
    return { invoiceId, lessonsDropped };
  });
}

export async function voidInvoice(actorId: string, invoiceId: string, reason: string) {
  return withTx(async (client) => {
    const inv = await lockInvoice(client, invoiceId);
    if (inv.status !== 'unpaid') throw conflict('Only an unpaid invoice can be voided');

    await client.query(`UPDATE invoices SET status = 'void', voided_at = now(), void_reason = $2 WHERE id = $1`, [
      invoiceId,
      reason,
    ]);
    // An enrollment that never got paid releases its seat.
    const released = await one(
      client,
      `UPDATE enrollments e SET status = 'cancelled', cancelled_at = now()
        WHERE e.id = $1 AND e.status = 'pending_payment'
          AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.enrollment_id = e.id AND i.status = 'paid')
        RETURNING e.id`,
      [inv.enrollment_id],
    );
    await audit(client, {
      actorId,
      entity: 'invoice',
      entityId: invoiceId,
      action: 'void',
      before: { status: 'unpaid' },
      after: { status: 'void', reason, seatReleased: Boolean(released) },
    });
    return { invoiceId, seatReleased: Boolean(released) };
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const INVOICE_SELECT = `
  SELECT i.id, i.invoice_no, i.enrollment_id, i.hours, i.rate_per_hour, i.amount, i.status,
         i.due_at, i.paid_at, i.payment_reference, i.voided_at, i.void_reason, i.created_at,
         c.id AS class_id, c.name AS class_name,
         s.id AS student_id, s.full_name AS student_name,
         CASE WHEN i.status = 'unpaid' AND i.due_at < now() THEN true ELSE false END AS is_overdue
    FROM invoices i
    JOIN enrollments e ON e.id = i.enrollment_id
    JOIN classes c ON c.id = e.class_id
    JOIN users s ON s.id = e.student_id`;

export async function studentInvoices(studentId: string) {
  return many(pool, `${INVOICE_SELECT} WHERE e.student_id = $1 ORDER BY i.created_at DESC`, [studentId]);
}

export async function adminInvoices(filter: { status?: string; classId?: string; studentId?: string }) {
  return many(
    pool,
    `${INVOICE_SELECT}
      WHERE ($1::invoice_status IS NULL OR i.status = $1::invoice_status)
        AND ($2::uuid IS NULL OR c.id = $2::uuid)
        AND ($3::uuid IS NULL OR s.id = $3::uuid)
      ORDER BY (i.status = 'unpaid') DESC, i.created_at DESC`,
    [filter.status ?? null, filter.classId ?? null, filter.studentId ?? null],
  );
}

export async function invoiceHistory(invoiceId: string) {
  return many(
    pool,
    `SELECT a.action, a.before, a.after, a.created_at, u.full_name AS actor_name, u.role AS actor_role
       FROM audit_logs a JOIN users u ON u.id = a.actor_id
      WHERE a.entity = 'invoice' AND a.entity_id = $1
      ORDER BY a.created_at`,
    [invoiceId],
  );
}

export async function adminStudents() {
  return many(
    pool,
    `SELECT u.id, u.full_name, u.email,
            COALESCE(json_agg(json_build_object(
              'enrollmentId', b.enrollment_id, 'classId', c.id, 'className', c.name,
              'status', b.enrollment_status, 'paidMinutes', b.paid_minutes, 'usedMinutes', b.used_minutes,
              'reservedMinutes', b.reserved_minutes, 'remainingMinutes', b.remaining_minutes,
              'availableMinutes', b.available_minutes, 'awaitingMinutes', b.awaiting_minutes
            ) ORDER BY c.name) FILTER (WHERE b.enrollment_id IS NOT NULL AND b.enrollment_status <> 'cancelled'), '[]')
              AS enrollments
       FROM users u
       LEFT JOIN v_enrollment_balance b ON b.student_id = u.id
       LEFT JOIN classes c ON c.id = b.class_id
      WHERE u.role = 'student'
      GROUP BY u.id
      ORDER BY u.full_name`,
  );
}
