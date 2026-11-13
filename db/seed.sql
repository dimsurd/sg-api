-- =====================================================================
-- Seed data. All accounts use the password:  Password123!
--
--   admin@stargeneration.test    Admin
--   tutor1@stargeneration.test   Tutor (assigned to "Math Group A")
--   tutor2@stargeneration.test   Tutor (no class yet)
--   student1@stargeneration.test Student (enrolled + paid, has history)
--   student2@stargeneration.test Student (not enrolled — takes the last seat)
--   student3@stargeneration.test Student (not enrolled — will hit "class full")
--
-- Dates are relative to "now" so the demo always has:
--   * 2 months ago: 2 lessons, logbook APPROVED, tutor earnings recorded
--   * last month:   2 lessons, logbook SUBMITTED (ready for admin review)
--   * upcoming:     2 scheduled lessons
-- =====================================================================

BEGIN;

INSERT INTO users (id, email, password_hash, full_name, role) VALUES
  ('00000000-0000-0000-0000-000000000001', 'admin@stargeneration.test',    crypt('Password123!', gen_salt('bf', 10)), 'Ayu Pratiwi',     'admin'),
  ('00000000-0000-0000-0000-000000000011', 'tutor1@stargeneration.test',   crypt('Password123!', gen_salt('bf', 10)), 'Budi Santoso',    'tutor'),
  ('00000000-0000-0000-0000-000000000012', 'tutor2@stargeneration.test',   crypt('Password123!', gen_salt('bf', 10)), 'Citra Lestari',   'tutor'),
  ('00000000-0000-0000-0000-000000000021', 'student1@stargeneration.test', crypt('Password123!', gen_salt('bf', 10)), 'Dimas Saputra',   'student'),
  ('00000000-0000-0000-0000-000000000022', 'student2@stargeneration.test', crypt('Password123!', gen_salt('bf', 10)), 'Eka Wulandari',   'student'),
  ('00000000-0000-0000-0000-000000000023', 'student3@stargeneration.test', crypt('Password123!', gen_salt('bf', 10)), 'Fajar Nugroho',   'student');

INSERT INTO classes (id, name, description, tutor_id, student_rate_per_hour, tutor_rate_per_hour, capacity, default_package_hours)
VALUES (
  '00000000-0000-0000-0000-000000000101',
  'Math Group A',
  'Grade 8 mathematics in a small group: algebra, geometry and problem solving.',
  '00000000-0000-0000-0000-000000000011',
  150000,  -- student rate / hour (IDR)
  100000,  -- tutor rate / hour (IDR)
  2,       -- capacity
  12       -- default package hours
);

DO $$
DECLARE
  v_admin   uuid := '00000000-0000-0000-0000-000000000001';
  v_tutor   uuid := '00000000-0000-0000-0000-000000000011';
  v_class   uuid := '00000000-0000-0000-0000-000000000101';
  v_enr     uuid := '00000000-0000-0000-0000-000000000201';
  v_this_m  date := wib_month(now());
  v_m2      date := (v_this_m - interval '2 months')::date;  -- approved month
  v_m1      date := (v_this_m - interval '1 month')::date;   -- submitted month
  v_lb2     uuid := '00000000-0000-0000-0000-000000000402';
  v_lb1     uuid := '00000000-0000-0000-0000-000000000401';
  -- 16:00 WIB on a given day of a month
  l_starts  timestamptz[];
  l_ids     uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000301'::uuid,  -- m2, lesson 1
    '00000000-0000-0000-0000-000000000302'::uuid,  -- m2, lesson 2
    '00000000-0000-0000-0000-000000000303'::uuid,  -- m1, lesson 1
    '00000000-0000-0000-0000-000000000304'::uuid,  -- m1, lesson 2
    '00000000-0000-0000-0000-000000000305'::uuid,  -- upcoming 1
    '00000000-0000-0000-0000-000000000306'::uuid   -- upcoming 2
  ];
  i int;
BEGIN
  l_starts := ARRAY[
    ((v_m2 + 6)  + time '16:00') AT TIME ZONE 'Asia/Jakarta',
    ((v_m2 + 13) + time '16:00') AT TIME ZONE 'Asia/Jakarta',
    ((v_m1 + 6)  + time '16:00') AT TIME ZONE 'Asia/Jakarta',
    ((v_m1 + 13) + time '16:00') AT TIME ZONE 'Asia/Jakarta',
    ((date (now() AT TIME ZONE 'Asia/Jakarta') + 3)  + time '16:00') AT TIME ZONE 'Asia/Jakarta',
    ((date (now() AT TIME ZONE 'Asia/Jakarta') + 10) + time '16:00') AT TIME ZONE 'Asia/Jakarta'
  ];

  -- student1: enrolled two months ago, paid a 12-hour package.
  INSERT INTO enrollments (id, class_id, student_id, status, created_at)
  VALUES (v_enr, v_class, '00000000-0000-0000-0000-000000000021', 'active', v_m2::timestamptz);

  INSERT INTO invoices (id, enrollment_id, hours, rate_per_hour, status, due_at, paid_at,
                        marked_paid_by, payment_reference, created_at)
  VALUES ('00000000-0000-0000-0000-000000000501', v_enr, 12, 150000, 'paid',
          v_m2::timestamptz + interval '7 days', v_m2::timestamptz + interval '1 day',
          v_admin, 'BCA transfer 0012', v_m2::timestamptz);

  -- Six 90-minute lessons; student1 participates in all of them.
  FOR i IN 1..6 LOOP
    INSERT INTO lessons (id, class_id, tutor_id, tutor_rate_per_hour, starts_at, ends_at, created_at)
    VALUES (l_ids[i], v_class, v_tutor, 100000, l_starts[i], l_starts[i] + interval '90 minutes',
            LEAST(now(), l_starts[i] - interval '7 days'));
    INSERT INTO lesson_participants (lesson_id, enrollment_id, minutes_charged)
    VALUES (l_ids[i], v_enr, 90);
  END LOOP;

  -- Two months ago: approved logbook with earnings.
  INSERT INTO logbooks (id, class_id, month) VALUES (v_lb2, v_class, v_m2);
  INSERT INTO logbook_entries (logbook_id, lesson_id, topic, activities, tutor_observation, future_recommendation) VALUES
    (v_lb2, l_ids[1], 'Linear equations',
     'Solved one- and two-step equations; group warm-up quiz.',
     'Dimas is confident with one-step equations but rushes the sign changes.',
     'Practise two-step equations with negative numbers.'),
    (v_lb2, l_ids[2], 'Word problems with equations',
     'Translated short stories into equations, then solved them in pairs.',
     'Good teamwork; translating text into variables is still slow.',
     'Next: keyword cheat-sheet and timed word-problem drills.');
  UPDATE logbooks SET status = 'submitted', submitted_at = v_m1::timestamptz WHERE id = v_lb2;
  INSERT INTO logbook_reviews (logbook_id, actor_id, action, created_at)
    VALUES (v_lb2, v_tutor, 'submitted', v_m1::timestamptz);
  INSERT INTO tutor_earnings (lesson_id, tutor_id, logbook_id, minutes, rate_per_hour, amount)
    SELECT l.id, l.tutor_id, v_lb2, l.duration_minutes, l.tutor_rate_per_hour,
           idr_for_minutes(l.tutor_rate_per_hour, l.duration_minutes)
    FROM lessons l WHERE l.id IN (l_ids[1], l_ids[2]);
  UPDATE logbooks SET status = 'approved', approved_at = v_m1::timestamptz + interval '2 days',
                      approved_by = v_admin WHERE id = v_lb2;
  INSERT INTO logbook_reviews (logbook_id, actor_id, action, comment, created_at)
    VALUES (v_lb2, v_admin, 'approved', 'Clear and useful, thanks!', v_m1::timestamptz + interval '2 days');

  -- Last month: submitted logbook, waiting for the admin.
  INSERT INTO logbooks (id, class_id, month) VALUES (v_lb1, v_class, v_m1);
  INSERT INTO logbook_entries (logbook_id, lesson_id, topic, activities, tutor_observation, future_recommendation) VALUES
    (v_lb1, l_ids[3], 'Angles and triangles',
     'Measured angles with protractors; proved the triangle angle sum.',
     'Strong visual intuition; needs to write reasons for each step.',
     'Two-column proofs for angle facts.'),
    (v_lb1, l_ids[4], 'Pythagoras theorem',
     'Discovered a² + b² = c² with paper squares, then applied it to ladders and ramps.',
     'Calculations are accurate; forgets to check which side is the hypotenuse.',
     'Mixed Pythagoras problems including finding a shorter side.');
  UPDATE logbooks SET status = 'submitted', submitted_at = v_this_m::timestamptz + interval '1 hour' WHERE id = v_lb1;
  INSERT INTO logbook_reviews (logbook_id, actor_id, action, created_at)
    VALUES (v_lb1, v_tutor, 'submitted', v_this_m::timestamptz + interval '1 hour');
END $$;

COMMIT;
