# Decisions

## The open decisions from the brief

### 1. How the invoice amount is calculated, and how hours are counted

- **Invoice:** one invoice = one **package** of hours.
  - Amount = `hours × the class's student rate at the moment the package is issued`. The rate is snapshotted on the invoice, so later rate changes never alter it.
  - The package size defaults to the class's package (12h in the seed).
- **Counting hours:** when a tutor schedules a lesson, every student with a paid, active enrollment whose *available* balance covers the **whole** lesson is added to it (`lesson_participants`).
  - Those minutes are *reserved* while the lesson is upcoming, and become *used* once it has ended.
  - The balance is always computed from these rows, never kept as a running counter:
    - remaining = paid − used
    - available = remaining − reserved
- **Why:** classes are taught offline, so the only reliable record is "this lesson took place and lasted X minutes". Reserving at scheduling time means a student can never be booked into more hours than they paid for.
  - *Trade-off:* a student with 1h left can't join a 1.5h lesson. We charge whole lessons only, rather than invent partial-lesson pricing.
  - Packages don't expire; the brief doesn't mention expiry.

### 2. When the admin changes a class's rate, capacity or tutor

- **Rate:** only affects what happens next.
  - Paid packages keep the price on their invoice.
  - A student-rate change applies to the next package.
  - A tutor-rate change applies to lessons scheduled from then on (the rate is snapshotted on each lesson), so the earnings preview for a month never shifts under the admin.
- **Capacity:** can't be set below the seats already taken (paid + awaiting payment). The API returns 409 and tells the admin to void unpaid enrollments first. Nobody who paid can be pushed out.
- **Tutor:**
  - Past lessons, and their earnings, stay with whoever taught them.
  - Upcoming lessons move to the new tutor at the class's tutor rate.
  - If the new tutor already teaches at any of those times, the change is rejected with the list of clashes.

### 3. When a student runs out of hours, or a lesson is cancelled

- **Out of hours:**
  - The student isn't added to new lessons. The tutor's scheduling result lists who was skipped, and the student sees that the lesson doesn't include them.
  - From ≤ 2h left, the student sees a **Buy package** button and the admin dashboard flags them with **Issue package invoice**.
  - A new package goes on the **same enrollment**, so the seat is kept. Paying it adds the student back into upcoming lessons in date order.
  - We never let the balance go negative: "students pay before they get access".
- **Cancelled lesson:** the tutor or the admin can cancel any lesson that hasn't ended, with a reason that students see.
  - Reserved hours return automatically, since balances only count scheduled lessons.
  - The tutor earns nothing for it, and it can't get a logbook entry.
  - A lesson that has already ended can't be cancelled; it happened and is paid.

### 4. When the admin finds a problem in a submitted logbook

- The admin clicks **Request changes** and must write a comment. The logbook moves to `changes_requested` and unlocks for the tutor.
- The tutor's home shows it as "sent back", with the comment. They fix it and **Resubmit**.
- Every step is kept in `logbook_reviews` and shown to both sides.
- Nothing is paid until approval, and the admin never edits the tutor's text: the logbook stays the tutor's account of the lesson.

### 5. How an invoice becomes Paid, who can mark it, and whether that can be undone

- **Who marks it paid:**
  - The **student** can press *Pay* (simulated, recorded with a `SIMULATED-…` reference).
  - The **admin** can *Mark paid* with a transfer reference, which is how payment actually arrives today.
- **Effect:** paying activates the enrollment, unlocks the class, and adds the student to upcoming lessons.
- **Undo:** only an admin can, and only while **none of that package's hours have been used**. Otherwise the student would have received lessons that are no longer paid for. Undoing may remove the student from the latest upcoming lessons.
- **Void:** an unpaid invoice can be voided; if the enrollment was never paid, the seat is released.
- Every money action requires a reference or reason and is written to `audit_logs`, visible as the invoice *History*.
- Only one unpaid package per enrollment is allowed, so invoices can't pile up.

## Other decisions

- **Plain PostgreSQL, no Supabase.**
  - The brief lists "Supabase Auth/PostgreSQL". We used PostgreSQL, the part that holds the business logic, without the Supabase platform.
  - Only the Express API ever touches the database, so Supabase's main benefit (row-level security for direct client access) doesn't apply. Instead, the invariants sit in plain Postgres constraints and triggers that any API bug still can't bypass.
  - Auth is bcrypt plus a JWT in an httpOnly, SameSite cookie, with a separate cookie per frontend.
  - Moving to Supabase later means pointing `DATABASE_URL` at it and swapping the login route for Supabase Auth. The schema runs unchanged.
- **Three repos (API, PWA, back office).** The audiences are different: students and tutors on phones, admins at a desk. Each app can be deployed and versioned on its own.
  - *Cost:* the frontends can't share code directly. We contained that by generating API types from `openapi.yaml` in both. The UI kit is copied for now.
- **Enrolling holds the seat while unpaid** (7-day due date). Otherwise a student could be told "enrolled" and then lose the seat to someone who paid faster. The admin releases abandoned seats with *Void*.
- **Students see every approved logbook of a class they've paid for**, including months before they joined. It's class progress, useful context for a newcomer. Lessons from before they joined aren't shown in *their* schedule.

## Improvement: Admin Money Dashboard

**Problem:** the brief says it directly. *"The admin cannot easily tell how many hours each student has left, which invoices are still unpaid, or whether a class is profitable."* The dashboard answers all three on one screen, and each answer comes with the action that fixes it.

1. **Unpaid invoices with aging** (not due / 1–7 / 8–30 / 30+ days overdue), with *Mark paid*, *Void* and *History* inline.
2. **Students low or out of hours**, with an *Issue package* button. The admin can invoice before a student misses a lesson, not after.
3. **Class profitability per month:**
   - *Billed* (cash in)
   - *Delivered revenue* (hours actually taught × what each student paid per hour)
   - *Approved* tutor pay
   - *Pending* tutor pay (estimated for lessons whose logbook isn't approved yet)
   - *Margin* in IDR and %

   A class running below break-even turns red. The Classes page also shows the margin per lesson hour when a class is full.

**Who it helps:** mostly the admin, who stops reconciling spreadsheets and chasing WhatsApp. Students benefit because packages get renewed before they run out. The same numbers also drive the student's own hours meter and the tutor's earnings screen.

**Why this over alternatives:**
- A tutor payout statement was the other strong candidate, but "see their own earnings per lesson and in total" is already required. We built that as approved vs pending per lesson and month, which answers "what will I be paid".
- Notifications would need WhatsApp or email integrations that wouldn't be worth it in one day.
- The dashboard addresses three of the four pains in the brief.

**How it's built:** SQL views (`v_enrollment_balance`, `v_invoice_aging`, `v_class_financials`), one endpoint (`GET /admin/reports/overview`), and tests on the balance and margin maths.

**Left out:**
- automated reminders
- CSV or accounting export
- margin forecasting from future schedules
- per-student attendance (everyone booked into a lesson is charged for it)

## What I'd build next with another day

1. **Reminders**: WhatsApp or email for invoices due or overdue, students low on hours, and tutors with lessons not yet logged.
2. **Automatic seat release**: unpaid enrollments expire after N days, so the admin no longer has to void them by hand.
3. **Attendance**: record absent students per lesson, with a policy for whether absence is charged.
4. **Refunds and package expiry rules**, if the business wants them.
5. **Shared `@sg/ui` package** for the design system, plus Playwright end-to-end tests across all three apps.
6. **Production hardening**: login rate limiting, password reset, deployment (API and Postgres on Railway or Fly; frontends on Vercel), and structured logging.
