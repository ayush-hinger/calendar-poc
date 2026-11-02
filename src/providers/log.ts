import { randomId } from '../crypto.ts';
import type { CalendarProvider, PushContext, PushResult } from './types.ts';

/**
 * A provider that records instead of calling out. It exists so the convergence
 * engine, the API and the UI can be exercised end-to-end with no credentials,
 * and so failure handling can be tested deterministically: a connection whose
 * account_email contains "fail" always throws.
 */
export const logProvider: CalendarProvider = {
  id: 'log',
  label: 'Simulated calendar',

  async push(ctx: PushContext): Promise<PushResult> {
    maybeFail(ctx);
    await delay();
    const externalId = ctx.target.external_event_id ?? randomId('log-ext');
    console.log(
      `[log] push ${ctx.event.title} v${ctx.event.version} -> ${ctx.connection.account_email} (${externalId})`,
    );
    return { externalId, etag: `v${ctx.event.version}` };
  },

  async remove(ctx: PushContext): Promise<void> {
    maybeFail(ctx);
    await delay();
    console.log(
      `[log] remove ${ctx.target.external_event_id} <- ${ctx.connection.account_email}`,
    );
  },
};

function maybeFail(ctx: PushContext): void {
  if (ctx.connection.account_email?.includes('fail')) {
    throw new Error('Simulated provider failure (account_email contains "fail")');
  }
}

function delay(): Promise<void> {
  return new Promise((r) => setTimeout(r, 150 + Math.random() * 250));
}
