import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors.js';

type PgError = Error & { code?: string; constraint?: string };

// Friendly messages for constraints that users can actually hit.
const CONSTRAINT_MESSAGES: Record<string, string> = {
  enrollments_one_live_per_student: 'You are already enrolled in this class',
  lessons_no_tutor_overlap: 'This lesson overlaps another lesson for the same tutor',
  lessons_end_after_start: 'Lesson end time must be after the start time',
  lessons_max_length: 'A lesson cannot be longer than 8 hours',
  logbooks_one_per_month: 'A logbook for this class and month already exists',
  logbook_entries_lesson_id_key: 'This lesson already has a logbook entry',
  tutor_earnings_lesson_id_key: 'Earnings for this lesson were already recorded',
};

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: err.issues[0]?.message ?? 'Invalid input',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }

  // express.json() failures: client errors, not server errors.
  const bodyErr = err as { type?: string };
  if (bodyErr.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'bad_request', message: 'The request body is not valid JSON' } });
    return;
  }
  if (bodyErr.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'payload_too_large', message: 'The request body is too large' } });
    return;
  }

  const pgErr = err as PgError;
  const friendly = pgErr.constraint ? CONSTRAINT_MESSAGES[pgErr.constraint] : undefined;
  switch (pgErr.code) {
    case '23505': // unique_violation
    case '23P01': // exclusion_violation
      res.status(409).json({ error: { code: 'conflict', message: friendly ?? 'This conflicts with existing data' } });
      return;
    case '23514': // check_violation (incl. assert_user_role)
      res.status(400).json({ error: { code: 'bad_request', message: friendly ?? pgErr.message } });
      return;
    case 'P0001': // RAISE EXCEPTION from a guard trigger
      res.status(409).json({ error: { code: 'conflict', message: pgErr.message } });
      return;
    case '22P02': // invalid_text_representation (e.g. bad uuid)
      res.status(400).json({ error: { code: 'bad_request', message: 'Invalid identifier' } });
      return;
  }

  console.error(err);
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
};
