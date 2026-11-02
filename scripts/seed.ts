/**
 * Seeds a teacher, three students with simulated calendars (one of which always
 * fails), and one class -- then drives the worker until everything converges.
 * Proves the fan-out, retry and convergence behaviour with no credentials.
 */
import { db } from '../src/db.ts';
import { randomId } from '../src/crypto.ts';
import { upsertConnection } from '../src/domain/connections.ts';
import { createEvent, targetsForEvent, updateEvent } from '../src/domain/events.ts';
import { drain } from '../src/sync/worker.ts';

function user(role: 'teacher' | 'student', name: string, email: string): string {
  const existing = db
    .prepare('SELECT id FROM users WHERE email = ?')
    .get(email) as { id: string } | undefined;
  if (existing) return existing.id;

  const id = randomId('usr');
  db.prepare('INSERT INTO users (id, role, name, email) VALUES (?, ?, ?, ?)').run(
    id,
    role,
    name,
    email,
  );
  return id;
}

const teacherId = user('teacher', 'Ms. Rao', 'teacher@example.com');

const students = [
  { name: 'Aisha Khan', email: 'aisha@example.com', calendar: 'aisha-google' },
  { name: 'Ben Oyelaran', email: 'ben@example.com', calendar: 'ben-outlook' },
  { name: 'Carla Diaz', email: 'carla@example.com', calendar: 'fail-icloud' },
].map((s) => {
  const id = user('student', s.name, s.email);
  upsertConnection({
    user_id: id,
    provider: 'log',
    account_email: s.calendar,
  });
  return { ...s, id };
});

const event = createEvent({
  teacher_id: teacherId,
  title: 'Algebra II — Chapter 4',
  description: 'Quadratic equations',
  location: 'Room 204',
  starts_at: '2026-11-10T09:00:00',
  ends_at: '2026-11-10T10:00:00',
  timezone: 'Asia/Kolkata',
  student_ids: students.map((s) => s.id),
});

console.log(`\nScheduled "${event.title}" (${event.id}) at v${event.version}`);
console.log(`Fanning out to ${targetsForEvent(event.id).length} calendars...\n`);

await drain(10_000);
report('After initial fan-out');

const edited = updateEvent(event.id, {
  title: 'Algebra II — Chapter 4 (moved)',
  starts_at: '2026-11-10T11:00:00',
  ends_at: '2026-11-10T12:00:00',
})!;
console.log(`\nEdited the class -> now v${edited.version}; every calendar is behind again.\n`);

await drain(10_000);
report('After the edit');

function report(label: string): void {
  console.log(`--- ${label} ---`);
  for (const t of targetsForEvent(event.id)) {
    const flag = t.synced_version >= t.event_version ? 'OK  ' : 'LAG ';
    console.log(
      `  ${flag} ${t.student_name.padEnd(16)} ${String(t.account_email).padEnd(14)} ` +
        `${t.state.padEnd(8)} v${t.synced_version}/${t.event_version}` +
        (t.last_error ? `  <- ${t.last_error}` : ''),
    );
  }
  console.log('');
}

console.log('Carla stays behind on purpose: her calendar label contains "fail",');
console.log('so the simulated provider always throws. The others still converge,');
console.log('which is the partial-failure behaviour the engine is built for.\n');
console.log('Now run: pnpm dev   and open http://localhost:3000\n');
process.exit(0);
