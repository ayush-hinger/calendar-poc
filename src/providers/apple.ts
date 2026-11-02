import { createDAVClient } from 'tsdav';
import { accessToken } from '../domain/connections.ts';
import { NeedsReauthError, RemoteGoneError } from '../domain/types.ts';
import type { Connection } from '../domain/types.ts';
import type { CalendarProvider, PushContext, PushResult } from './types.ts';
import { buildIcs } from './ics.ts';

export const ICLOUD_CALDAV_URL = 'https://caldav.icloud.com';

/**
 * Apple has no OAuth and no REST calendar API, so this adapter speaks CalDAV
 * (RFC 4791) with Basic auth and an app-specific password the student generates
 * at account.apple.com. Discovery redirects to a regional host such as
 * p42-caldav.icloud.com, which we persist at connect time.
 */

function basicAuth(connection: Connection): string {
  const password = accessToken(connection);
  if (!connection.account_email || !password) {
    throw new NeedsReauthError('Missing iCloud credentials; reconnect the account.');
  }
  return `Basic ${Buffer.from(`${connection.account_email}:${password}`).toString('base64')}`;
}

/** Deterministic object path, so the remote URL is recomputable without our mapping. */
function objectUrl(connection: Connection, uid: string): string {
  const base = connection.caldav_calendar_url;
  if (!base) throw new NeedsReauthError('No iCloud calendar URL stored; reconnect the account.');
  return `${base.endsWith('/') ? base : `${base}/`}${encodeURIComponent(uid)}.ics`;
}

interface DiscoveredCalendar {
  url: string;
  displayName: string;
}

/** Log in, find the writable event calendars, and return them for selection. */
export async function discoverCalendars(
  appleId: string,
  appPassword: string,
): Promise<{ accountUrl: string; calendars: DiscoveredCalendar[] }> {
  let client: Awaited<ReturnType<typeof createDAVClient>>;
  try {
    client = await createDAVClient({
      serverUrl: ICLOUD_CALDAV_URL,
      credentials: { username: appleId, password: appPassword },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new NeedsReauthError(
      `iCloud rejected the credentials. Use a 16-character app-specific password ` +
        `from account.apple.com, not the Apple Account password. (${message.slice(0, 160)})`,
    );
  }

  const calendars = await client.fetchCalendars();
  const usable = calendars
    .filter((c) => {
      const components = (c.components ?? []) as string[];
      return components.length === 0 || components.includes('VEVENT');
    })
    .filter((c) => Boolean(c.url))
    .map((c) => ({
      url: c.url as string,
      displayName:
        typeof c.displayName === 'string' && c.displayName ? c.displayName : 'Calendar',
    }));

  if (usable.length === 0) {
    throw new NeedsReauthError('No writable iCloud calendar found for this account.');
  }

  return { accountUrl: ICLOUD_CALDAV_URL, calendars: usable };
}

function stripWeak(etag: string | null): string | null {
  return etag ? etag.replace(/^W\//, '') : null;
}

export const appleProvider: CalendarProvider = {
  id: 'apple',
  label: 'Apple iCloud',

  async push(ctx: PushContext): Promise<PushResult> {
    const url = objectUrl(ctx.connection, ctx.event.ical_uid);
    const isUpdate = Boolean(ctx.target.external_event_id);

    const headers: Record<string, string> = {
      Authorization: basicAuth(ctx.connection),
      'Content-Type': 'text/calendar; charset=utf-8',
    };

    // Conditional PUTs keep concurrent writers from clobbering each other:
    // If-None-Match:* means "only if absent", If-Match:<etag> means "only if unchanged".
    if (!isUpdate) {
      headers['If-None-Match'] = '*';
    } else if (ctx.target.external_etag) {
      headers['If-Match'] = ctx.target.external_etag;
    }

    let res = await fetch(url, { method: 'PUT', headers, body: buildIcs(ctx.event) });

    // 412 on create => it already exists; 412 on update => it changed underneath us.
    // Either way, re-PUT unconditionally: the platform is the system of record.
    if (res.status === 412) {
      const retryHeaders = { ...headers };
      delete retryHeaders['If-None-Match'];
      delete retryHeaders['If-Match'];
      res = await fetch(url, {
        method: 'PUT',
        headers: retryHeaders,
        body: buildIcs(ctx.event),
      });
    }

    if (res.status === 401 || res.status === 403) {
      throw new NeedsReauthError(
        'iCloud rejected the stored app-specific password. Apple revokes these when ' +
          'the Apple Account password changes — generate a new one and reconnect.',
      );
    }
    if (!res.ok) {
      throw new Error(
        `iCloud PUT failed (${res.status}): ${(await res.text()).slice(0, 300)}`,
      );
    }

    // iCloud often omits the ETag on PUT; fetch it so the next update can be conditional.
    let etag = stripWeak(res.headers.get('etag'));
    if (!etag) {
      const head = await fetch(url, {
        method: 'HEAD',
        headers: { Authorization: basicAuth(ctx.connection) },
      });
      etag = stripWeak(head.headers.get('etag'));
    }

    return { externalId: url, etag };
  },

  async remove(ctx: PushContext): Promise<void> {
    const url = ctx.target.external_event_id ?? objectUrl(ctx.connection, ctx.event.ical_uid);

    const headers: Record<string, string> = { Authorization: basicAuth(ctx.connection) };
    if (ctx.target.external_etag) headers['If-Match'] = ctx.target.external_etag;

    let res = await fetch(url, { method: 'DELETE', headers });

    // Deleted under us, or our ETag is stale -- retry unconditionally.
    if (res.status === 412) {
      res = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: basicAuth(ctx.connection) },
      });
    }

    if (res.status === 404 || res.status === 410) return;
    if (res.status === 401 || res.status === 403) {
      throw new NeedsReauthError('iCloud rejected the stored app-specific password.');
    }
    if (!res.ok) {
      throw new Error(
        `iCloud DELETE failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    }
  },
};

export { RemoteGoneError };
