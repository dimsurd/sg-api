-- =====================================================================
-- OPTIONAL demo catalogue — NOT part of the brief's required seed.
--
-- The brief asks for exactly one class (Math Group A, capacity 2), which
-- db/seed.sql provides and the tests rely on. This file adds the live group
-- classes listed on stargeneration.id/our-programs?tab=group (read 2026-11-13)
-- so the catalogue looks like the real one in a demo.
--
--   pnpm db:seed:catalog     (run after db:reset; safe to run twice)
--
-- Mapping from the website:
--   student rate / hour = price per session ÷ session length
--   package hours       = sessions available × session length (rounded)
--   tutor rate / hour   = ASSUMPTION: 60% of the student rate (not public)
--   capacity            = ASSUMPTION: 6 (not public)
--   tutor               = split between the two seeded tutors by subject
-- =====================================================================

INSERT INTO classes (name, description, tutor_id, student_rate_per_hour, tutor_rate_per_hour, capacity, default_package_hours)
SELECT v.name, v.description, v.tutor_id::uuid, v.srate, v.trate, v.capacity, v.pkg
FROM (VALUES
  ('Cambridge Primary Checkpoint Science Grade 6', 'Primary Checkpoint Combined Science. Weekly on Thursday, 19.00–20.30 WIB, online. Rp180.000/session (9 sessions).', '00000000-0000-0000-0000-000000000012', 120000, 70000, 6, 14),
  ('Cambridge Primary Checkpoint English Grade 6', 'Primary Checkpoint English. Weekly on Friday, 19.00–20.30 WIB, online. Rp180.000/session (10 sessions).', '00000000-0000-0000-0000-000000000012', 120000, 70000, 6, 15),
  ('OSN IPA Biologi SMP', 'OSN IPA. Weekly on Friday, 18.00–19.00 WIB, online. Rp180.000/session (5 sessions).', '00000000-0000-0000-0000-000000000012', 180000, 110000, 6, 5),
  ('OSN IPA Fisika SMP', 'OSN IPA. Weekly on Friday, 17.00–18.00 WIB, online. Rp180.000/session (5 sessions).', '00000000-0000-0000-0000-000000000011', 180000, 110000, 6, 5),
  ('Cambridge IGCSE Physics Grade 10', 'IGCSE Physics. Weekly on Thursday, 19.00–20.30 WIB, online. Rp270.000/session (2 sessions).', '00000000-0000-0000-0000-000000000011', 180000, 110000, 6, 3),
  ('Cambridge IGCSE Mathematics Grade 10', 'IGCSE Extended Mathematics. Weekly on Friday, 19.30–21.00 WIB, online. Rp270.000/session (3 sessions).', '00000000-0000-0000-0000-000000000011', 180000, 110000, 6, 5),
  ('OSN Matematika SMA', 'OSN Math. Weekly on Tuesday, 18.30–20.30 WIB, online. Rp360.000/session (4 sessions).', '00000000-0000-0000-0000-000000000011', 180000, 110000, 6, 8),
  ('OSN Matematika SMP (Wednesday)', 'OSN Math. Weekly on Wednesday, 18.00–20.00 WIB, online. Rp360.000/session (4 sessions).', '00000000-0000-0000-0000-000000000011', 180000, 110000, 6, 8),
  ('OSN Matematika SD (Friday)', 'OSN Math. Weekly on Friday, 18.00–20.00 WIB, online. Rp360.000/session (5 sessions).', '00000000-0000-0000-0000-000000000012', 180000, 110000, 6, 10),
  ('OSN Matematika SD (Monday)', 'OSN Math. Weekly on Monday, 17.00–19.00 WIB, online. Rp360.000/session (4 sessions).', '00000000-0000-0000-0000-000000000012', 180000, 110000, 6, 8),
  ('OSN Matematika SMP (Friday)', 'OSN Math. Weekly on Friday, 18.30–20.30 WIB, online. Rp360.000/session (5 sessions).', '00000000-0000-0000-0000-000000000011', 180000, 110000, 6, 10),
  ('OSN Matematika SMP Special Class', 'OSN Math. Weekly on Monday, 18.30–20.30 WIB, online. Rp360.000/session (4 sessions).', '00000000-0000-0000-0000-000000000011', 180000, 110000, 6, 8),
  ('Math Olympiad Grade 7-8', 'Math Olympiad. Weekly on Thursday, 17.30–19.30 WIB, online. Rp360.000/session (4 sessions).', '00000000-0000-0000-0000-000000000011', 180000, 110000, 6, 8),
  ('Math Olympiad Grade 5-6', 'Math Olympiad. Weekly on Monday, 17.00–19.00 WIB, online. Rp360.000/session (5 sessions).', '00000000-0000-0000-0000-000000000012', 180000, 110000, 6, 10),
  ('Cambridge Secondary Checkpoint English Grade 8', 'Secondary Checkpoint English. Weekly on Thursday, 19.00–20.30 WIB, online. Rp225.000/session (2 sessions).', '00000000-0000-0000-0000-000000000012', 150000, 90000, 6, 3),
  ('Cambridge Secondary Science Grade 9', 'IGCSE Combined Science. Weekly on Monday, 19.00–20.30 WIB, online. Rp225.000/session (3 sessions).', '00000000-0000-0000-0000-000000000012', 150000, 90000, 6, 5)
) AS v(name, description, tutor_id, srate, trate, capacity, pkg)
WHERE NOT EXISTS (SELECT 1 FROM classes c WHERE c.name = v.name);
