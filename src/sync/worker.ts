import { config } from '../config.ts';
import { claimableTargets, pendingCount, processTarget } from './engine.ts';

let timer: NodeJS.Timeout | null = null;
let running = false;
const inFlight = new Set<string>();

/**
 * Polls for lagging targets and pushes them. A poll loop over the sync_targets
 * table (rather than an in-memory queue) is what makes the POC crash-safe: the
 * pending work is the table, so restarting the process resumes a half-finished
 * fan-out with no extra bookkeeping.
 */
async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const batch = claimableTargets(10).filter((t) => !inFlight.has(t.id));
    if (batch.length === 0) return;

    await Promise.all(
      batch.map(async (target) => {
        inFlight.add(target.id);
        try {
          await processTarget(target);
        } catch (err) {
          console.error(`[sync] unhandled error on target ${target.id}:`, err);
        } finally {
          inFlight.delete(target.id);
        }
      }),
    );
  } finally {
    running = false;
  }
}

export function startWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, config.SYNC_POLL_MS);
  console.log(`[sync] worker started (poll ${config.SYNC_POLL_MS}ms)`);
}

export function stopWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Run the loop until everything has converged. Used by tests and the CLI demo. */
export async function drain(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pendingCount() === 0) return true;
    await tick();
    await new Promise((r) => setTimeout(r, 100));
  }
  return pendingCount() === 0;
}
