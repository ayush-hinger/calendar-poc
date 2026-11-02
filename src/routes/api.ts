import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.ts';
import { randomId } from '../crypto.ts';
import { googleConfigured, microsoftConfigured } from '../config.ts';
import {
  cancelEvent,
  createEvent,
  getEvent,
  listEvents,
  materializeTargets,
  targetsForEvent,
  updateEvent,
} from '../domain/events.ts';
import { listStudents, upsertConnection } from '../domain/connections.ts';
import { pendingCount, retryEvent } from '../sync/engine.ts';
import { reconcileEvent } from '../sync/reconcile.ts';
import { providerLabels } from '../providers/index.ts';

export const apiRouter = Router();

function teacher(): { id: string; name: string } {
  let row = db
    .prepare(`SELECT id, name FROM users WHERE role = 'teacher' LIMIT 1`)
    .get() as { id: string; name: string } | undefined;

  if (!row) {
    const id = randomId('usr');
    db.prepare(
      `INSERT INTO users (id, role, name, email) VALUES (?, 'teacher', ?, ?)`,
    ).run(id, 'Teacher', 'teacher@example.com');
    row = { id, name: 'Teacher' };
  }
  return row;
}

apiRouter.get('/bootstrap', (_req, res) => {
  res.json({
    teacher: teacher(),
    students: listStudents(),
    providerLabels,
    configured: {
      google: googleConfigured,
      microsoft: microsoftConfigured,
      apple: true,
    },
    pending: pendingCount(),
  });
});

const eventSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullish(),
  location: z.string().nullish(),
  starts_at: z.string().min(1),
  ends_at: z.string().min(1),
  timezone: z.string().default('UTC'),
  student_ids: z.array(z.string()).default([]),
});

apiRouter.get('/events', (_req, res) => {
  const events = listEvents().map((e) => {
    const targets = targetsForEvent(e.id);
    return {
      ...e,
      target_count: targets.length,
      synced_count: targets.filter((t) => t.synced_version >= e.version).length,
    };
  });
  res.json({ events });
});

apiRouter.post('/events', (req, res) => {
  const parsed = eventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: z.treeifyError(parsed.error) });
  }

  const studentIds =
    parsed.data.student_ids.length > 0
      ? parsed.data.student_ids
      : (db.prepare(`SELECT id FROM users WHERE role = 'student'`).all() as Array<{
          id: string;
        }>).map((r) => r.id);

  const event = createEvent({
    teacher_id: teacher().id,
    ...parsed.data,
    student_ids: studentIds,
  });
  res.status(201).json({ event, targets: targetsForEvent(event.id) });
});

apiRouter.get('/events/:id', (req, res) => {
  const event = getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Not found' });
  res.json({ event, targets: targetsForEvent(event.id) });
});

apiRouter.get('/events/:id/targets', (req, res) => {
  const event = getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Not found' });

  const targets = targetsForEvent(event.id);
  res.json({
    version: event.version,
    status: event.status,
    targets,
    converged: targets.every((t) => t.synced_version >= event.version),
  });
});

const patchSchema = eventSchema.partial().omit({ student_ids: true });

apiRouter.patch('/events/:id', (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: z.treeifyError(parsed.error) });
  }
  const event = updateEvent(req.params.id, parsed.data);
  if (!event) return res.status(404).json({ error: 'Not found' });
  res.json({ event, targets: targetsForEvent(event.id) });
});

apiRouter.post('/events/:id/cancel', (req, res) => {
  const event = cancelEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Not found' });
  res.json({ event, targets: targetsForEvent(event.id) });
});

apiRouter.post('/events/:id/retry', (req, res) => {
  if (!getEvent(req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json({ requeued: retryEvent(req.params.id) });
});

apiRouter.post('/events/:id/reconcile', (req, res) => {
  if (!getEvent(req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json({ rewound: reconcileEvent(req.params.id) });
});

apiRouter.get('/events/:id/log', (req, res) => {
  const rows = db
    .prepare(
      `SELECT l.*, c.provider, u.name AS student_name
         FROM sync_log l
         JOIN sync_targets t ON t.id = l.target_id
         JOIN connections c ON c.id = t.connection_id
         JOIN users u ON u.id = c.user_id
        WHERE t.event_id = ?
        ORDER BY l.id DESC LIMIT 60`,
    )
    .all(req.params.id);
  res.json({ entries: rows });
});

// ------------------------------------------------------------- students

apiRouter.get('/students', (_req, res) => {
  res.json({ students: listStudents() });
});

apiRouter.post('/students', (req, res) => {
  const parsed = z
    .object({ name: z.string().min(1), email: z.string().nullish() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'name is required' });

  const id = randomId('usr');
  db.prepare(`INSERT INTO users (id, role, name, email) VALUES (?, 'student', ?, ?)`).run(
    id,
    parsed.data.name,
    parsed.data.email ?? null,
  );

  // Enrol the new student in every scheduled class.
  const events = db
    .prepare(`SELECT id FROM class_events WHERE status = 'scheduled'`)
    .all() as Array<{ id: string }>;
  for (const e of events) {
    db.prepare(
      'INSERT OR IGNORE INTO enrollments (event_id, student_id) VALUES (?, ?)',
    ).run(e.id, id);
    materializeTargets(e.id);
  }

  res.status(201).json({ id });
});

/**
 * Attach a simulated calendar, so fan-out, retry and convergence are demoable
 * with no provider credentials at all. Pass a label containing "fail" to make
 * that target fail deterministically and exercise the retry path.
 */
apiRouter.post('/students/:id/simulate', (req, res) => {
  const label = String(req.body?.label ?? 'simulated');
  const connection = upsertConnection({
    user_id: req.params.id,
    provider: 'log',
    account_email: label,
  });

  const events = db
    .prepare(`SELECT id FROM class_events WHERE status = 'scheduled'`)
    .all() as Array<{ id: string }>;
  for (const e of events) {
    db.prepare(
      'INSERT OR IGNORE INTO enrollments (event_id, student_id) VALUES (?, ?)',
    ).run(e.id, req.params.id);
    materializeTargets(e.id);
  }

  res.status(201).json({ connection: { id: connection.id, provider: connection.provider } });
});

apiRouter.delete('/connections/:id', (req, res) => {
  db.prepare('DELETE FROM connections WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

apiRouter.get('/pending', (_req, res) => {
  res.json({ pending: pendingCount() });
});
