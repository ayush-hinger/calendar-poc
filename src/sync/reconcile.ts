import { db } from '../db.ts';

/**
 * Force every copy of an event to be re-pushed.
 *
 * Because each adapter's push is an upsert keyed on a stable identity, replaying
 * is safe and repairs drift: a student who deleted their copy locally gets it
 * back, and one that was edited in their own calendar is brought back in line
 * with the platform.
 *
 * Implemented by rewinding synced_version, which is the same signal an edit
 * produces -- so reconciliation needs no separate code path in the worker.
 */
export function reconcileEvent(eventId: string): number {
  const res = db
    .prepare(
      `UPDATE sync_targets
          SET synced_version = 0, state = 'pending', attempts = 0,
              next_attempt_at = 0, updated_at = datetime('now')
        WHERE event_id = ? AND state != 'removed'`,
    )
    .run(eventId);
  return res.changes;
}

/** Rewind every scheduled event. Used by the periodic drift sweep. */
export function reconcileAll(): number {
  const res = db
    .prepare(
      `UPDATE sync_targets
          SET synced_version = 0, state = 'pending', attempts = 0, next_attempt_at = 0
        WHERE event_id IN (SELECT id FROM class_events WHERE status = 'scheduled')
          AND state IN ('synced','failed')`,
    )
    .run();
  return res.changes;
}
