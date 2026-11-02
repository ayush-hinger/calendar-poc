import { db, logSync } from '../db.ts';
import { config } from '../config.ts';
import { getEvent } from '../domain/events.ts';
import { getConnection, markNeedsReauth } from '../domain/connections.ts';
import { NeedsReauthError, RemoteGoneError } from '../domain/types.ts';
import type { SyncTarget } from '../domain/types.ts';
import { providerFor } from '../providers/index.ts';

/** Targets whose remote copy is behind the event's current version. */
export function claimableTargets(limit = 10): SyncTarget[] {
  return db
    .prepare(
      `SELECT t.* FROM sync_targets t
         JOIN class_events ce ON ce.id = t.event_id
        WHERE t.synced_version < ce.version
          AND t.state IN ('pending','failed')
          AND t.next_attempt_at <= ?
        ORDER BY t.next_attempt_at ASC, t.id ASC
        LIMIT ?`,
    )
    .all(Date.now(), limit) as SyncTarget[];
}

export function pendingCount(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sync_targets t
         JOIN class_events ce ON ce.id = t.event_id
        WHERE t.synced_version < ce.version AND t.state IN ('pending','failed')`,
    )
    .get() as { n: number };
  return row.n;
}

function markSynced(
  target: SyncTarget,
  version: number,
  externalId: string | null,
  etag: string | null,
  state: 'synced' | 'removed',
): void {
  db.prepare(
    `UPDATE sync_targets
        SET external_event_id = ?, external_etag = ?, synced_version = ?,
            state = ?, attempts = 0, next_attempt_at = 0, last_error = NULL,
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(externalId, etag, version, state, target.id);
}

function markFailure(target: SyncTarget, err: unknown, terminal: boolean): void {
  const message = err instanceof Error ? err.message : String(err);
  const attempts = target.attempts + 1;
  const dead = terminal || attempts >= config.SYNC_MAX_ATTEMPTS;

  // Exponential backoff with jitter so a provider outage does not become a hot loop.
  const backoffMs = Math.min(2 ** attempts * 1000, 60_000);
  const jitter = Math.floor(Math.random() * 500);

  db.prepare(
    `UPDATE sync_targets
        SET state = ?, attempts = ?, next_attempt_at = ?, last_error = ?,
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(
    dead ? 'dead' : 'failed',
    attempts,
    dead ? 0 : Date.now() + backoffMs + jitter,
    message.slice(0, 500),
    target.id,
  );

  logSync(target.id, dead ? 'dead' : 'retry', false, message.slice(0, 500));
}

/**
 * Drive one target to the event's current version.
 *
 * This is deliberately the only place that talks to a provider, and it is safe
 * to call repeatedly: pushes are upserts keyed on a stable identity, so a retry
 * after a partial failure converges rather than duplicating.
 */
export async function processTarget(target: SyncTarget): Promise<void> {
  const event = getEvent(target.event_id);
  const connection = getConnection(target.connection_id);

  if (!event || !connection) {
    db.prepare(`UPDATE sync_targets SET state = 'dead', last_error = ? WHERE id = ?`).run(
      'Event or connection no longer exists',
      target.id,
    );
    return;
  }

  if (connection.status === 'revoked') {
    markFailure(target, new Error('Calendar connection was revoked'), true);
    return;
  }

  const provider = providerFor(connection.provider);
  const ctx = { connection, event, target };

  try {
    if (event.status === 'cancelled') {
      if (target.external_event_id) {
        await provider.remove(ctx);
        logSync(target.id, 'remove', true, `v${event.version}`);
      }
      markSynced(target, event.version, null, null, 'removed');
      return;
    }

    const result = await provider.push(ctx);
    markSynced(target, event.version, result.externalId, result.etag ?? null, 'synced');
    logSync(target.id, 'push', true, `v${event.version} -> ${result.externalId}`);
  } catch (err) {
    if (err instanceof RemoteGoneError) {
      // The student deleted their copy. Forget the stale id; the next tick recreates it.
      db.prepare(
        `UPDATE sync_targets
            SET external_event_id = NULL, external_etag = NULL, state = 'pending',
                next_attempt_at = 0, last_error = ?, updated_at = datetime('now')
          WHERE id = ?`,
      ).run(err.message.slice(0, 500), target.id);
      logSync(target.id, 'recreate', true, err.message.slice(0, 500));
      return;
    }

    if (err instanceof NeedsReauthError) {
      markNeedsReauth(connection.id, err.message);
      markFailure(target, err, true);
      return;
    }

    markFailure(target, err, false);
  }
}

/** Reset dead/failed targets so they are retried immediately. */
export function retryEvent(eventId: string): number {
  const res = db
    .prepare(
      `UPDATE sync_targets
          SET state = 'pending', attempts = 0, next_attempt_at = 0,
              updated_at = datetime('now')
        WHERE event_id = ? AND state IN ('failed','dead')`,
    )
    .run(eventId);
  return res.changes;
}
