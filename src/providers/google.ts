import { google } from 'googleapis';
import type { calendar_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { config, redirectUri } from '../config.ts';
import { accessToken, refreshToken, saveTokens } from '../domain/connections.ts';
import { NeedsReauthError, RemoteGoneError } from '../domain/types.ts';
import type { Connection } from '../domain/types.ts';
import type { CalendarProvider, PushContext, PushResult } from './types.ts';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
];

export function googleOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    redirectUri('google'),
  );
}

function clientFor(connection: Connection): OAuth2Client {
  const client = googleOAuthClient();
  client.setCredentials({
    access_token: accessToken(connection),
    refresh_token: refreshToken(connection),
    expiry_date: connection.expires_at,
  });

  // google-auth-library refreshes transparently; persist whatever it hands back
  // so the next process start does not have to re-authorise.
  client.on('tokens', (tokens) => {
    saveTokens(connection.id, {
      access_token: tokens.access_token ?? undefined,
      refresh_token: tokens.refresh_token ?? undefined,
      expires_at: tokens.expiry_date ?? undefined,
    });
  });

  return client;
}

function calendarFor(connection: Connection): calendar_v3.Calendar {
  return google.calendar({ version: 'v3', auth: clientFor(connection) });
}

function body(ctx: PushContext): calendar_v3.Schema$Event {
  const { event } = ctx;
  return {
    summary: event.title,
    description: event.description ?? undefined,
    location: event.location ?? undefined,
    start: { dateTime: event.starts_at, timeZone: event.timezone },
    end: { dateTime: event.ends_at, timeZone: event.timezone },
    // Surfaced in the UI and handy when debugging against a real calendar.
    extendedProperties: {
      private: {
        platformEventId: event.id,
        platformVersion: String(event.version),
      },
    },
  };
}

function status(err: unknown): number | undefined {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: number } };
  if (typeof e.code === 'number') return e.code;
  if (typeof e.status === 'number') return e.status;
  return e.response?.status;
}

function rethrow(err: unknown): never {
  const code = status(err);
  const message = err instanceof Error ? err.message : String(err);

  if (message.includes('invalid_grant')) {
    throw new NeedsReauthError(
      'Google refused the stored credential (invalid_grant). In a Testing-mode ' +
        'OAuth project, consent and refresh tokens expire after 7 days — reconnect the account.',
    );
  }
  if (code === 401 || code === 403) throw new NeedsReauthError(`Google denied access: ${message}`);
  if (code === 404 || code === 410) throw new RemoteGoneError(`Google event is gone: ${message}`);
  throw err instanceof Error ? err : new Error(message);
}

export const googleProvider: CalendarProvider = {
  id: 'google',
  label: 'Google Calendar',

  async push(ctx: PushContext): Promise<PushResult> {
    const cal = calendarFor(ctx.connection);

    if (ctx.target.external_event_id) {
      try {
        const res = await cal.events.patch({
          calendarId: 'primary',
          eventId: ctx.target.external_event_id,
          requestBody: body(ctx),
        });
        return { externalId: res.data.id!, etag: res.data.etag ?? null };
      } catch (err) {
        rethrow(err);
      }
    }

    // events.import is the documented way to place a copy of an existing event
    // into a calendar, and it requires our iCalUID. Because identity is the UID,
    // importing twice updates the same event instead of creating a duplicate --
    // which is exactly the idempotency the retry loop depends on.
    try {
      const res = await cal.events.import({
        calendarId: 'primary',
        requestBody: { ...body(ctx), iCalUID: ctx.event.ical_uid },
      });
      return { externalId: res.data.id!, etag: res.data.etag ?? null };
    } catch (err) {
      const adopted = await findByUid(ctx).catch(() => null);
      if (adopted) return adopted;
      rethrow(err);
    }
  },

  async remove(ctx: PushContext): Promise<void> {
    if (!ctx.target.external_event_id) return;
    const cal = calendarFor(ctx.connection);
    try {
      await cal.events.delete({
        calendarId: 'primary',
        eventId: ctx.target.external_event_id,
      });
    } catch (err) {
      // Already gone is success for a delete.
      const code = status(err);
      if (code === 404 || code === 410) return;
      rethrow(err);
    }
  },
};

/** Recover the remote id from the shared UID when our mapping is lost. */
async function findByUid(ctx: PushContext): Promise<PushResult | null> {
  const cal = calendarFor(ctx.connection);
  const res = await cal.events.list({
    calendarId: 'primary',
    iCalUID: ctx.event.ical_uid,
    showDeleted: false,
    maxResults: 1,
  });
  const found = res.data.items?.[0];
  return found?.id ? { externalId: found.id, etag: found.etag ?? null } : null;
}

export async function googleAccountEmail(client: OAuth2Client): Promise<string | null> {
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const me = await oauth2.userinfo.get();
    return me.data.email ?? null;
  } catch {
    return null;
  }
}
