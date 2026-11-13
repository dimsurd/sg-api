import { z } from 'zod';

export const uuid = z.guid('Invalid identifier');

/** ISO 8601 with an explicit offset, e.g. 2026-11-20T16:00:00+07:00 (WIB). */
export const isoDateTime = z.iso.datetime({ offset: true, message: 'Use an ISO date-time with a timezone offset' });

/** 'YYYY-MM' -> 'YYYY-MM-01' (first day of month, as stored in logbooks.month). */
export const monthParam = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must look like 2026-11')
  .transform((m) => `${m}-01`);

export const idrAmount = z.number().int('Must be a whole rupiah amount').positive('Must be greater than 0').max(100_000_000);

export const packageHours = z.number().int('Hours must be a whole number').min(1).max(200);

export const idParams = z.object({ id: uuid });
