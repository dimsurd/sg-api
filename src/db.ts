import pg from 'pg';
import { config } from './config.js';

// Return BIGINT (IDR amounts) as JS numbers. Safe: amounts stay far below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
// Return NUMERIC as numbers too (only used for computed ratios).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
// Keep DATE as 'YYYY-MM-DD' strings (no timezone shifting).
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

// Sessions run in UTC so every timestamp (incl. ones built inside json_build_object)
// serialises the same way; WIB is applied explicitly in SQL (wib_month) and in the UI.
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, options: '-c TimeZone=UTC' });

// An idle client can be dropped by the server (restart, failover, admin kill). Without a
// listener, pg re-emits that as an unhandled 'error' event and the whole process exits.
// The pool already discards the broken client and opens a new one on the next query.
pool.on('error', (err) => {
  console.error('[db] idle client error, connection discarded:', err.message);
});

export type Db = pg.Pool | pg.PoolClient;

/** Run fn inside a transaction; rolls back on any thrown error. */
export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T extends pg.QueryResultRow>(
  db: Db,
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const res = await db.query<T>(text, params);
  return res.rows[0];
}

export async function many<T extends pg.QueryResultRow>(
  db: Db,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await db.query<T>(text, params);
  return res.rows;
}
