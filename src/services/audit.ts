import type { Db } from '../db.js';

export async function audit(
  db: Db,
  entry: { actorId: string; entity: string; entityId: string; action: string; before?: unknown; after?: unknown },
) {
  await db.query(
    `INSERT INTO audit_logs (actor_id, entity, entity_id, action, before, after)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.actorId,
      entry.entity,
      entry.entityId,
      entry.action,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
    ],
  );
}
