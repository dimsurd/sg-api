-- =====================================================================
-- Star Generation — Group Class Enrollment & Billing
-- PostgreSQL schema. Hard business invariants live here so that no API
-- bug can break them; workflow rules live in the API service layer.
--
-- Conventions
--   * Money is IDR stored as BIGINT (no floats, no decimals).
--   * Durations are stored in minutes (INT).
--   * Timestamps are TIMESTAMPTZ (UTC). "Month" for logbooks/reports is
--     computed in Asia/Jakarta (WIB, UTC+7).
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), crypt() for seed
CREATE EXTENSION IF NOT EXISTS btree_gist; -- uuid "=" inside EXCLUDE constraint

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
CREATE TYPE user_role         AS ENUM ('admin', 'tutor', 'student');
CREATE TYPE class_status      AS ENUM ('active', 'archived');
CREATE TYPE enrollment_status AS ENUM ('pending_payment', 'active', 'cancelled');
CREATE TYPE invoice_status    AS ENUM ('unpaid', 'paid', 'void');
CREATE TYPE lesson_status     AS ENUM ('scheduled', 'cancelled');
CREATE TYPE logbook_status    AS ENUM ('draft', 'submitted', 'changes_requested', 'approved');
CREATE TYPE review_action     AS ENUM ('submitted', 'changes_requested', 'approved');

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
-- Month bucket (first day) of a timestamp in WIB.
CREATE FUNCTION wib_month(ts timestamptz) RETURNS date
LANGUAGE sql IMMUTABLE AS $$
  SELECT date_trunc('month', ts AT TIME ZONE 'Asia/Jakarta')::date
$$;

-- IDR amount for a duration at an hourly rate, rounded to the nearest rupiah.
CREATE FUNCTION idr_for_minutes(rate_per_hour bigint, minutes int) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
  SELECT round(rate_per_hour::numeric * minutes / 60)::bigint
$$;

CREATE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash text NOT NULL,
  full_name     text NOT NULL,
  role          user_role NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Guard: a FK column that must point at a user with a given role.
CREATE FUNCTION assert_user_role(p_user uuid, p_role user_role) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_user IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users WHERE id = p_user AND role = p_role AND is_active
  ) THEN
    RAISE EXCEPTION 'User % is not an active %', p_user, p_role
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- classes
-- ---------------------------------------------------------------------
CREATE TABLE classes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL CHECK (length(trim(name)) > 0),
  description           text NOT NULL DEFAULT '',
  tutor_id              uuid NOT NULL REFERENCES users(id),
  student_rate_per_hour bigint NOT NULL CHECK (student_rate_per_hour > 0),
  tutor_rate_per_hour   bigint NOT NULL CHECK (tutor_rate_per_hour > 0),
  capacity              int NOT NULL CHECK (capacity > 0),
  default_package_hours int NOT NULL DEFAULT 12 CHECK (default_package_hours > 0),
  status                class_status NOT NULL DEFAULT 'active',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX classes_tutor_idx ON classes (tutor_id);

CREATE FUNCTION classes_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_user_role(NEW.tutor_id, 'tutor');
  RETURN NEW;
END $$;
CREATE TRIGGER classes_guard BEFORE INSERT OR UPDATE OF tutor_id ON classes
  FOR EACH ROW EXECUTE FUNCTION classes_guard();
CREATE TRIGGER classes_touch BEFORE UPDATE ON classes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------
-- enrollments  (a student's seat in a class; packages hang off it)
-- ---------------------------------------------------------------------
CREATE TABLE enrollments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id     uuid NOT NULL REFERENCES classes(id),
  student_id   uuid NOT NULL REFERENCES users(id),
  status       enrollment_status NOT NULL DEFAULT 'pending_payment',
  created_at   timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz
);
-- Rule: no duplicate enrollment (a cancelled one may be re-done).
CREATE UNIQUE INDEX enrollments_one_live_per_student
  ON enrollments (class_id, student_id) WHERE status <> 'cancelled';
CREATE INDEX enrollments_student_idx ON enrollments (student_id);

CREATE FUNCTION enrollments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_user_role(NEW.student_id, 'student');
  RETURN NEW;
END $$;
CREATE TRIGGER enrollments_guard BEFORE INSERT ON enrollments
  FOR EACH ROW EXECUTE FUNCTION enrollments_guard();

-- ---------------------------------------------------------------------
-- invoices  (one invoice = one package of hours)
-- ---------------------------------------------------------------------
CREATE SEQUENCE invoice_no_seq;

CREATE TABLE invoices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no        text NOT NULL UNIQUE
                    DEFAULT 'INV-' || to_char(now() AT TIME ZONE 'Asia/Jakarta', 'YYYY')
                            || '-' || lpad(nextval('invoice_no_seq')::text, 4, '0'),
  enrollment_id     uuid NOT NULL REFERENCES enrollments(id),
  hours             int NOT NULL CHECK (hours > 0),
  rate_per_hour     bigint NOT NULL CHECK (rate_per_hour > 0),   -- snapshot at issue
  amount            bigint GENERATED ALWAYS AS (hours * rate_per_hour) STORED,
  status            invoice_status NOT NULL DEFAULT 'unpaid',
  due_at            timestamptz NOT NULL DEFAULT now() + interval '7 days',
  paid_at           timestamptz,
  marked_paid_by    uuid REFERENCES users(id),
  payment_reference text,
  voided_at         timestamptz,
  void_reason       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoices_paid_fields CHECK (
    (status = 'paid') = (paid_at IS NOT NULL AND marked_paid_by IS NOT NULL)
  ),
  CONSTRAINT invoices_void_fields CHECK ((status = 'void') = (voided_at IS NOT NULL))
);
CREATE INDEX invoices_enrollment_idx ON invoices (enrollment_id);
-- Rule: at most one unpaid package per enrollment (no stacking unpaid invoices).
CREATE UNIQUE INDEX invoices_one_unpaid_per_enrollment
  ON invoices (enrollment_id) WHERE status = 'unpaid';
CREATE INDEX invoices_unpaid_idx ON invoices (due_at) WHERE status = 'unpaid';

-- ---------------------------------------------------------------------
-- lessons
-- ---------------------------------------------------------------------
CREATE TABLE lessons (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id            uuid NOT NULL REFERENCES classes(id),
  tutor_id            uuid NOT NULL REFERENCES users(id),     -- who teaches THIS lesson
  tutor_rate_per_hour bigint NOT NULL CHECK (tutor_rate_per_hour > 0), -- snapshot
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  duration_minutes    int GENERATED ALWAYS AS
                      ((extract(epoch FROM (ends_at - starts_at)) / 60)::int) STORED,
  status              lesson_status NOT NULL DEFAULT 'scheduled',
  cancel_reason       text,
  cancelled_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Rule: end must follow start (and a sane upper bound).
  CONSTRAINT lessons_end_after_start CHECK (ends_at > starts_at),
  CONSTRAINT lessons_max_length CHECK (ends_at - starts_at <= interval '8 hours'),
  CONSTRAINT lessons_cancel_fields CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  -- Rule: a tutor's (non-cancelled) lessons cannot overlap.
  CONSTRAINT lessons_no_tutor_overlap EXCLUDE USING gist (
    tutor_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'scheduled')
);
CREATE INDEX lessons_class_time_idx ON lessons (class_id, starts_at);

CREATE FUNCTION lessons_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_user_role(NEW.tutor_id, 'tutor');
  RETURN NEW;
END $$;
CREATE TRIGGER lessons_guard BEFORE INSERT OR UPDATE OF tutor_id ON lessons
  FOR EACH ROW EXECUTE FUNCTION lessons_guard();

-- Which enrollments are charged for a lesson (fixed when scheduled).
CREATE TABLE lesson_participants (
  lesson_id       uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  enrollment_id   uuid NOT NULL REFERENCES enrollments(id),
  minutes_charged int NOT NULL CHECK (minutes_charged > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lesson_id, enrollment_id)
);
CREATE INDEX lesson_participants_enrollment_idx ON lesson_participants (enrollment_id);

-- ---------------------------------------------------------------------
-- logbooks  (one per class per WIB month)
-- ---------------------------------------------------------------------
CREATE TABLE logbooks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id     uuid NOT NULL REFERENCES classes(id),
  month        date NOT NULL CHECK (date_trunc('month', month)::date = month),
  status       logbook_status NOT NULL DEFAULT 'draft',
  submitted_at timestamptz,
  approved_at  timestamptz,
  approved_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- Rule: one logbook per class per month.
  CONSTRAINT logbooks_one_per_month UNIQUE (class_id, month),
  CONSTRAINT logbooks_approved_fields CHECK (
    (status = 'approved') = (approved_at IS NOT NULL AND approved_by IS NOT NULL)
  )
);

-- Rule: an approved logbook is read-only (no edits, no deletes, no un-approve).
CREATE FUNCTION logbooks_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'Logbook is approved and read-only' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER logbooks_guard BEFORE UPDATE OR DELETE ON logbooks
  FOR EACH ROW EXECUTE FUNCTION logbooks_guard();

CREATE TABLE logbook_entries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  logbook_id            uuid NOT NULL REFERENCES logbooks(id),
  lesson_id             uuid NOT NULL UNIQUE REFERENCES lessons(id), -- one entry per lesson
  topic                 text NOT NULL CHECK (length(trim(topic)) > 0),
  activities            text NOT NULL CHECK (length(trim(activities)) > 0),
  tutor_observation     text NOT NULL CHECK (length(trim(tutor_observation)) > 0),
  future_recommendation text NOT NULL CHECK (length(trim(future_recommendation)) > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX logbook_entries_logbook_idx ON logbook_entries (logbook_id);

-- Rules: entries only for ended, non-cancelled lessons of the same class
-- and month; nothing changes once the logbook is approved.
CREATE FUNCTION logbook_entries_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lb logbooks%ROWTYPE;
  ls lessons%ROWTYPE;
BEGIN
  SELECT * INTO lb FROM logbooks
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.logbook_id ELSE NEW.logbook_id END;
  IF lb.status = 'approved' THEN
    RAISE EXCEPTION 'Logbook is approved and read-only' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;

  SELECT * INTO ls FROM lessons WHERE id = NEW.lesson_id;
  IF ls.class_id <> lb.class_id THEN
    RAISE EXCEPTION 'Lesson belongs to a different class' USING ERRCODE = 'P0001';
  END IF;
  IF ls.status <> 'scheduled' THEN
    RAISE EXCEPTION 'Cannot log a cancelled lesson' USING ERRCODE = 'P0001';
  END IF;
  IF ls.ends_at > now() THEN
    RAISE EXCEPTION 'Lesson has not ended yet' USING ERRCODE = 'P0001';
  END IF;
  IF wib_month(ls.starts_at) <> lb.month THEN
    RAISE EXCEPTION 'Lesson is not in this logbook''s month' USING ERRCODE = 'P0001';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER logbook_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON logbook_entries
  FOR EACH ROW EXECUTE FUNCTION logbook_entries_guard();

-- Review history: submit / request changes / approve, with comments.
CREATE TABLE logbook_reviews (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  logbook_id uuid NOT NULL REFERENCES logbooks(id),
  actor_id   uuid NOT NULL REFERENCES users(id),
  action     review_action NOT NULL,
  comment    text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX logbook_reviews_logbook_idx ON logbook_reviews (logbook_id, created_at);

-- ---------------------------------------------------------------------
-- tutor_earnings  (written once per lesson when its logbook is approved)
-- ---------------------------------------------------------------------
CREATE TABLE tutor_earnings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id     uuid NOT NULL UNIQUE REFERENCES lessons(id), -- idempotency: once per lesson
  tutor_id      uuid NOT NULL REFERENCES users(id),
  logbook_id    uuid NOT NULL REFERENCES logbooks(id),
  minutes       int NOT NULL CHECK (minutes > 0),
  rate_per_hour bigint NOT NULL CHECK (rate_per_hour > 0),
  amount        bigint NOT NULL CHECK (amount = idr_for_minutes(rate_per_hour, minutes)),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tutor_earnings_tutor_idx ON tutor_earnings (tutor_id);

-- ---------------------------------------------------------------------
-- audit_logs  (money-affecting admin actions: mark/undo paid, void, class edits)
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   uuid NOT NULL REFERENCES users(id),
  entity     text NOT NULL,
  entity_id  uuid NOT NULL,
  action     text NOT NULL,
  before     jsonb,
  after      jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity, entity_id, created_at);

-- =====================================================================
-- Views — single source of truth for balances and money reports.
-- The API, the student balance meter and the admin dashboard all read
-- these, so the formulas cannot drift apart.
-- =====================================================================

-- Hours balance per enrollment.
--   paid      = hours of paid packages
--   used      = minutes of lessons that ended AND the tutor has logged (the logbook
--               entry is the proof the lesson happened)
--   awaiting  = minutes of lessons that ended but have no entry yet — not deducted,
--               but still held so nobody can be booked beyond what they paid
--   reserved  = minutes booked in upcoming lessons
--   remaining = paid - used                         (what the student "has left")
--   available = paid - used - awaiting - reserved   (what can still be scheduled)
CREATE VIEW v_enrollment_balance AS
SELECT
  e.id          AS enrollment_id,
  e.class_id,
  e.student_id,
  e.status      AS enrollment_status,
  COALESCE(p.paid_minutes, 0)::int                                       AS paid_minutes,
  COALESCE(p.paid_amount, 0)::bigint                                     AS paid_amount,
  COALESCE(u.used_minutes, 0)::int                                       AS used_minutes,
  COALESCE(u.reserved_minutes, 0)::int                                   AS reserved_minutes,
  (COALESCE(p.paid_minutes, 0) - COALESCE(u.used_minutes, 0))::int       AS remaining_minutes,
  (COALESCE(p.paid_minutes, 0) - COALESCE(u.used_minutes, 0)
     - COALESCE(u.awaiting_minutes, 0) - COALESCE(u.reserved_minutes, 0))::int AS available_minutes,
  COALESCE(u.awaiting_minutes, 0)::int                                   AS awaiting_minutes
FROM enrollments e
LEFT JOIN LATERAL (
  SELECT sum(i.hours * 60) AS paid_minutes, sum(i.amount) AS paid_amount
  FROM invoices i
  WHERE i.enrollment_id = e.id AND i.status = 'paid'
) p ON true
LEFT JOIN LATERAL (
  SELECT
    sum(lp.minutes_charged) FILTER (WHERE l.ends_at <= now() AND le.id IS NOT NULL) AS used_minutes,
    sum(lp.minutes_charged) FILTER (WHERE l.ends_at <= now() AND le.id IS NULL)     AS awaiting_minutes,
    sum(lp.minutes_charged) FILTER (WHERE l.ends_at >  now())                        AS reserved_minutes
  FROM lesson_participants lp
  JOIN lessons l ON l.id = lp.lesson_id
  LEFT JOIN logbook_entries le ON le.lesson_id = l.id
  WHERE lp.enrollment_id = e.id AND l.status = 'scheduled'
) u ON true;

-- Unpaid invoices with an aging bucket (based on due_at).
CREATE VIEW v_invoice_aging AS
SELECT
  i.*,
  e.class_id,
  e.student_id,
  GREATEST(0, floor(extract(epoch FROM (now() - i.due_at)) / 86400))::int AS days_overdue,
  CASE
    WHEN now() <= i.due_at                          THEN 'not_due'
    WHEN now() - i.due_at <= interval '7 days'      THEN 'overdue_1_7'
    WHEN now() - i.due_at <= interval '30 days'     THEN 'overdue_8_30'
    ELSE 'overdue_30_plus'
  END AS aging_bucket
FROM invoices i
JOIN enrollments e ON e.id = i.enrollment_id
WHERE i.status = 'unpaid';

-- Profitability per class per WIB month.
--   billed            = cash in from packages paid that month
--   delivered_revenue = logged (confirmed) minutes that month x the student's average paid rate
--   tutor_cost_*      = approved earnings, and an estimate for held-but-unapproved lessons
--   margin            = delivered_revenue - (approved + pending tutor cost)
CREATE VIEW v_class_financials AS
WITH billed AS (
  SELECT e.class_id, wib_month(i.paid_at) AS month, sum(i.amount) AS billed
  FROM invoices i JOIN enrollments e ON e.id = i.enrollment_id
  WHERE i.status = 'paid'
  GROUP BY 1, 2
),
enrollment_rate AS (
  SELECT enrollment_id,
         CASE WHEN paid_minutes > 0 THEN paid_amount::numeric / paid_minutes ELSE 0 END AS rate_per_minute
  FROM v_enrollment_balance
),
delivered AS (
  SELECT l.class_id, wib_month(l.starts_at) AS month,
         round(sum(lp.minutes_charged * r.rate_per_minute))::bigint AS delivered_revenue,
         sum(lp.minutes_charged)::int AS delivered_student_minutes
  FROM lessons l
  JOIN lesson_participants lp ON lp.lesson_id = l.id
  JOIN enrollment_rate r      ON r.enrollment_id = lp.enrollment_id
  WHERE l.status = 'scheduled' AND l.ends_at <= now()
    AND EXISTS (SELECT 1 FROM logbook_entries le WHERE le.lesson_id = l.id) -- confirmed by the tutor
  GROUP BY 1, 2
),
tutor AS (
  SELECT l.class_id, wib_month(l.starts_at) AS month,
         count(*)::int AS lessons_held,
         COALESCE(sum(te.amount), 0)::bigint AS tutor_cost_approved,
         COALESCE(sum(idr_for_minutes(l.tutor_rate_per_hour, l.duration_minutes))
                  FILTER (WHERE te.id IS NULL), 0)::bigint AS tutor_cost_pending
  FROM lessons l
  LEFT JOIN tutor_earnings te ON te.lesson_id = l.id
  WHERE l.status = 'scheduled' AND l.ends_at <= now()
  GROUP BY 1, 2
),
months AS (
  SELECT class_id, month FROM billed
  UNION SELECT class_id, month FROM delivered
  UNION SELECT class_id, month FROM tutor
)
SELECT
  m.class_id,
  c.name AS class_name,
  m.month,
  COALESCE(b.billed, 0)::bigint                   AS billed,
  COALESCE(d.delivered_revenue, 0)::bigint        AS delivered_revenue,
  COALESCE(d.delivered_student_minutes, 0)::int   AS delivered_student_minutes,
  COALESCE(t.lessons_held, 0)::int                AS lessons_held,
  COALESCE(t.tutor_cost_approved, 0)::bigint      AS tutor_cost_approved,
  COALESCE(t.tutor_cost_pending, 0)::bigint       AS tutor_cost_pending,
  (COALESCE(d.delivered_revenue, 0) - COALESCE(t.tutor_cost_approved, 0)
     - COALESCE(t.tutor_cost_pending, 0))::bigint AS margin
FROM months m
JOIN classes c       ON c.id = m.class_id
LEFT JOIN billed b    ON b.class_id = m.class_id AND b.month = m.month
LEFT JOIN delivered d ON d.class_id = m.class_id AND d.month = m.month
LEFT JOIN tutor t     ON t.class_id = m.class_id AND t.month = m.month;

COMMIT;
