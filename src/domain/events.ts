import { db } from '../db.ts';
import { randomId } from '../crypto.ts';
import type { ClassEvent, Connection, SyncTarget } from './types.ts';

export interface EventInput {
  teacher_id: string;
  title: string;
  description?: string | null;
  location?: string | null;
  starts_at: string;
  ends_at: string;
  timezone?: string;
  student_ids: string[];
}

/**
 * Every copy of a class across every provider shares this iCalendar identity.
 * Google and Apple carry it natively; Outlook cannot (iCalUId is read-only there)
 * so the Microsoft adapter stores it in an extended property instead.
 */
function icalUid(eventId: string): string {
  return `${eventId}@calendar-poc`;
}

export function getEvent(id: string): ClassEvent | undefined {
  return db.prepare('SELECT * FROM class_events WHERE id = ?').get(id) as
    | ClassEvent
    | undefined;
}

export function listEvents(): ClassEvent[] {
  return db
    .prepare('SELECT * FROM class_events ORDER BY starts_at DESC')
    .all() as ClassEvent[];
}

/**
 * Create a sync_target for each active calendar connection of each enrolled
 * student. Safe to re-run: existing rows are left untouched, so a student who
 * connects a calendar later is picked up on the next call.
 */
export function materializeTargets(eventId: string): number {
  const connections = db
    .prepare(
      `SELECT c.* FROM connections c
         JOIN enrollments e ON e.student_id = c.user_id
        WHERE e.event_id = ? AND c.status != 'revoked'`,
    )
    .all(eventId) as Connection[];

  const insert = db.prepare(
    `INSERT INTO sync_targets (id, event_id, connection_id, state)
     VALUES (?, ?, ?, 'pending')
     ON CONFLICT (event_id, connection_id) DO NOTHING`,
  );

  let created = 0;
  const tx = db.transaction(() => {
    for (const c of connections) {
      const res = insert.run(randomId('tgt'), eventId, c.id);
      created += res.changes;
    }
  });
  tx();
  return created;
}

/** Re-queue every target of this event. Called after any mutation. */
function markTargetsDirty(eventId: string): void {
  db.prepare(
    `UPDATE sync_targets
        SET state = 'pending', attempts = 0, next_attempt_at = 0,
            updated_at = datetime('now')
      WHERE event_id = ? AND state != 'removed'`,
  ).run(eventId);
}

export function createEvent(input: EventInput): ClassEvent {
  const id = randomId('evt');
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO class_events
         (id, teacher_id, title, description, location, starts_at, ends_at, timezone, ical_uid)
       VALUES (@id, @teacher_id, @title, @description, @location, @starts_at, @ends_at, @timezone, @ical_uid)`,
    ).run({
      id,
      teacher_id: input.teacher_id,
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      starts_at: input.starts_at,
      ends_at: input.ends_at,
      timezone: input.timezone ?? 'UTC',
      ical_uid: icalUid(id),
    });

    const enroll = db.prepare(
      'INSERT OR IGNORE INTO enrollments (event_id, student_id) VALUES (?, ?)',
    );
    for (const sid of input.student_ids) enroll.run(id, sid);
  });
  tx();

  materializeTargets(id);
  return getEvent(id)!;
}

export type EventPatch = Partial<
  Pick<
    ClassEvent,
    'title' | 'description' | 'location' | 'starts_at' | 'ends_at' | 'timezone'
  >
>;

/**
 * Apply an edit and bump the version. The version bump is the entire mechanism
 * by which the change reaches every student: the worker pushes any target whose
 * synced_version has fallen behind.
 */
export function updateEvent(id: string, patch: EventPatch): ClassEvent | undefined {
  const existing = getEvent(id);
  if (!existing) return undefined;

  const fields = Object.keys(patch).filter(
    (k) => patch[k as keyof EventPatch] !== undefined,
  );

  const tx = db.transaction(() => {
    if (fields.length > 0) {
      const setSql = fields.map((f) => `${f} = @${f}`).join(', ');
      db.prepare(
        `UPDATE class_events
            SET ${setSql}, version = version + 1, updated_at = datetime('now')
          WHERE id = @id`,
      ).run({ ...patch, id });
    } else {
      // No field changed, but the caller asked for a resync.
      db.prepare(
        `UPDATE class_events SET version = version + 1, updated_at = datetime('now')
          WHERE id = @id`,
      ).run({ id });
    }
    markTargetsDirty(id);
  });
  tx();

  // Pick up students who connected a calendar since the last push.
  materializeTargets(id);
  return getEvent(id);
}

/** Cancel: the engine deletes the remote copy from every student's calendar. */
export function cancelEvent(id: string): ClassEvent | undefined {
  const existing = getEvent(id);
  if (!existing) return undefined;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE class_events
          SET status = 'cancelled', version = version + 1, updated_at = datetime('now')
        WHERE id = ?`,
    ).run(id);
    markTargetsDirty(id);
  });
  tx();
  return getEvent(id);
}

export interface TargetView extends SyncTarget {
  student_id: string;
  student_name: string;
  provider: string;
  account_email: string | null;
  connection_status: string;
  event_version: number;
}

export function targetsForEvent(eventId: string): TargetView[] {
  return db
    .prepare(
      `SELECT t.*, u.id AS student_id, u.name AS student_name,
              c.provider, c.account_email, c.status AS connection_status,
              ce.version AS event_version
         FROM sync_targets t
         JOIN connections c ON c.id = t.connection_id
         JOIN users u ON u.id = c.user_id
         JOIN class_events ce ON ce.id = t.event_id
        WHERE t.event_id = ?
        ORDER BY u.name, c.provider`,
    )
    .all(eventId) as TargetView[];
}
