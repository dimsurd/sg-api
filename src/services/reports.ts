/**
 * Tutor earnings and the Admin Money Dashboard (our improvement).
 * Numbers come from the SQL views in schema.sql so every screen agrees.
 */
import { many, one, pool } from '../db.js';

// ---------------------------------------------------------------------------
// Earnings — visible only to the admin and the tutor themselves.
// ---------------------------------------------------------------------------

/**
 * One row per held lesson (ended, not cancelled):
 *  - approved: recorded in tutor_earnings (final)
 *  - pending:  logbook not approved yet (estimate at the lesson's snapshotted rate)
 */
export async function earnings(filter: { tutorId?: string }) {
  const lines = await many<{
    lesson_id: string;
    class_id: string;
    class_name: string;
    tutor_id: string;
    tutor_name: string;
    starts_at: Date;
    month: string;
    minutes: number;
    rate_per_hour: number;
    amount: number;
    status: 'approved' | 'pending';
    logbook_status: string;
  }>(
    pool,
    `SELECT l.id AS lesson_id, c.id AS class_id, c.name AS class_name, l.tutor_id, t.full_name AS tutor_name,
            l.starts_at, to_char(wib_month(l.starts_at), 'YYYY-MM') AS month,
            COALESCE(te.minutes, l.duration_minutes) AS minutes,
            COALESCE(te.rate_per_hour, l.tutor_rate_per_hour) AS rate_per_hour,
            COALESCE(te.amount, idr_for_minutes(l.tutor_rate_per_hour, l.duration_minutes)) AS amount,
            CASE WHEN te.id IS NOT NULL THEN 'approved' ELSE 'pending' END AS status,
            COALESCE(lb.status::text, 'not_started') AS logbook_status
       FROM lessons l
       JOIN classes c ON c.id = l.class_id
       JOIN users t ON t.id = l.tutor_id
       LEFT JOIN tutor_earnings te ON te.lesson_id = l.id
       LEFT JOIN logbooks lb ON lb.class_id = l.class_id AND lb.month = wib_month(l.starts_at)
      WHERE l.status = 'scheduled' AND l.ends_at <= now()
        AND ($1::uuid IS NULL OR l.tutor_id = $1::uuid)
      ORDER BY l.starts_at DESC`,
    [filter.tutorId ?? null],
  );

  const totals = { approved: 0, pending: 0, approvedMinutes: 0, pendingMinutes: 0 };
  const byMonth = new Map<string, { month: string; approved: number; pending: number; lessons: number }>();
  for (const l of lines) {
    if (l.status === 'approved') {
      totals.approved += l.amount;
      totals.approvedMinutes += l.minutes;
    } else {
      totals.pending += l.amount;
      totals.pendingMinutes += l.minutes;
    }
    const m = byMonth.get(l.month) ?? { month: l.month, approved: 0, pending: 0, lessons: 0 };
    m[l.status] += l.amount;
    m.lessons += 1;
    byMonth.set(l.month, m);
  }
  return { totals, months: [...byMonth.values()], lines };
}

// ---------------------------------------------------------------------------
// Admin Money Dashboard
// ---------------------------------------------------------------------------

/** Low = <= 2h left, or everything left is already booked into upcoming lessons. */
const LOW_BALANCE_MINUTES = 120;

export async function overview(filter: { month?: string; classId?: string }) {
  const month = filter.month ?? null; // 'YYYY-MM-01'
  const classId = filter.classId ?? null;

  const unpaid = await many(
    pool,
    `SELECT a.id, a.invoice_no, a.amount, a.hours, a.due_at, a.created_at, a.days_overdue, a.aging_bucket,
            a.enrollment_id, c.id AS class_id, c.name AS class_name, s.id AS student_id, s.full_name AS student_name
       FROM v_invoice_aging a
       JOIN classes c ON c.id = a.class_id
       JOIN users s ON s.id = a.student_id
      WHERE ($1::uuid IS NULL OR a.class_id = $1::uuid)
      ORDER BY a.due_at`,
    [classId],
  );

  const balances = await many<{ remaining_minutes: number; available_minutes: number; flag: string }>(
    pool,
    `SELECT b.enrollment_id, b.enrollment_status, b.paid_minutes, b.used_minutes, b.reserved_minutes,
            b.remaining_minutes, b.available_minutes,
            c.id AS class_id, c.name AS class_name, c.default_package_hours,
            s.id AS student_id, s.full_name AS student_name,
            EXISTS (SELECT 1 FROM invoices i WHERE i.enrollment_id = b.enrollment_id AND i.status = 'unpaid')
              AS has_unpaid_package,
            CASE
              WHEN b.enrollment_status = 'pending_payment' THEN 'awaiting_payment'
              WHEN b.remaining_minutes <= 0                THEN 'out'
              WHEN b.remaining_minutes <= $2 OR b.available_minutes <= 0 THEN 'low'
              ELSE 'ok'
            END AS flag
       FROM v_enrollment_balance b
       JOIN classes c ON c.id = b.class_id
       JOIN users s ON s.id = b.student_id
      WHERE b.enrollment_status <> 'cancelled'
        AND ($1::uuid IS NULL OR b.class_id = $1::uuid)
      ORDER BY CASE
                 WHEN b.enrollment_status = 'pending_payment' THEN 2
                 WHEN b.remaining_minutes <= 0 THEN 0
                 WHEN b.remaining_minutes <= $2 OR b.available_minutes <= 0 THEN 1
                 ELSE 3 END,
               b.remaining_minutes, s.full_name`,
    [classId, LOW_BALANCE_MINUTES],
  );

  const financials = await many<{ margin: number; delivered_revenue: number }>(
    pool,
    `SELECT class_id, class_name, to_char(month, 'YYYY-MM') AS month, billed, delivered_revenue,
            delivered_student_minutes, lessons_held, tutor_cost_approved, tutor_cost_pending, margin,
            CASE WHEN delivered_revenue > 0 THEN round(margin::numeric * 100 / delivered_revenue, 1) END AS margin_pct
       FROM v_class_financials
      WHERE ($1::date IS NULL OR month = $1::date)
        AND ($2::uuid IS NULL OR class_id = $2::uuid)
      ORDER BY month DESC, class_name`,
    [month, classId],
  );

  const kpiMonth = month ?? (await one<{ m: string }>(pool, 'SELECT wib_month(now())::text AS m'))!.m;
  const monthMargin = await one<{ margin: number; delivered_revenue: number; billed: number }>(
    pool,
    `SELECT COALESCE(sum(margin), 0)::bigint AS margin, COALESCE(sum(delivered_revenue), 0)::bigint AS delivered_revenue,
            COALESCE(sum(billed), 0)::bigint AS billed
       FROM v_class_financials WHERE month = $1::date AND ($2::uuid IS NULL OR class_id = $2::uuid)`,
    [kpiMonth, classId],
  );

  return {
    kpis: {
      outstandingAmount: unpaid.reduce((s, i) => s + Number((i as { amount: number }).amount), 0),
      unpaidCount: unpaid.length,
      overdueCount: unpaid.filter((i) => (i as { aging_bucket: string }).aging_bucket !== 'not_due').length,
      lowBalanceCount: balances.filter((b) => b.flag === 'low' || b.flag === 'out').length,
      month: kpiMonth.slice(0, 7),
      monthBilled: monthMargin!.billed,
      monthDeliveredRevenue: monthMargin!.delivered_revenue,
      monthMargin: monthMargin!.margin,
    },
    unpaidInvoices: unpaid,
    balances,
    classFinancials: financials,
  };
}
