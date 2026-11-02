import { config, redirectUri } from '../config.ts';
import { deterministicKey } from '../crypto.ts';
import { accessToken, refreshToken, saveTokens } from '../domain/connections.ts';
import { NeedsReauthError, RemoteGoneError } from '../domain/types.ts';
import type { Connection } from '../domain/types.ts';
import type { CalendarProvider, PushContext, PushResult } from './types.ts';

export const MICROSOFT_SCOPES = ['Calendars.ReadWrite', 'offline_access', 'User.Read'];

const GRAPH = 'https://graph.microsoft.com/v1.0';

export function microsoftAuthority(): string {
  return `https://login.microsoftonline.com/${config.MICROSOFT_TENANT}/oauth2/v2.0`;
}

/**
 * Outlook's iCalUId is read-only, so unlike Google and Apple we cannot stamp our
 * shared UID onto the event. We carry it in a named extended property instead,
 * which also makes the copy findable again if our mapping is ever lost.
 */
function uidPropertyId(): string {
  return `String {${config.MICROSOFT_EXT_PROP_GUID}} Name PlatformEventUid`;
}

export async function refreshMicrosoftToken(connection: Connection): Promise<string> {
  const refresh = refreshToken(connection);
  if (!refresh) {
    throw new NeedsReauthError('No Microsoft refresh token stored; reconnect the account.');
  }

  const res = await fetch(`${microsoftAuthority()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.MICROSOFT_CLIENT_ID ?? '',
      client_secret: config.MICROSOFT_CLIENT_SECRET ?? '',
      grant_type: 'refresh_token',
      refresh_token: refresh,
      redirect_uri: redirectUri('microsoft'),
      scope: MICROSOFT_SCOPES.join(' '),
    }),
  });

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !data.access_token) {
    throw new NeedsReauthError(
      `Microsoft token refresh failed: ${data.error_description ?? data.error ?? res.status}`,
    );
  }

  saveTokens(connection.id, {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  });
  return data.access_token;
}

interface GraphOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Graph call that refreshes an expired token once, then retries. */
async function graph<T>(
  connection: Connection,
  path: string,
  options: GraphOptions = {},
  isRetry = false,
): Promise<{ status: number; data: T }> {
  let token = accessToken(connection);
  const expired = connection.expires_at != null && connection.expires_at < Date.now() + 30_000;
  if (!token || (expired && !isRetry)) {
    token = await refreshMicrosoftToken(connection);
  }

  const res = await fetch(`${GRAPH}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      // Immutable ids survive the event being moved between folders, which would
      // otherwise silently break our stored mapping.
      Prefer: 'IdType="ImmutableId"',
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 401 && !isRetry) {
    await refreshMicrosoftToken(connection);
    const fresh = { ...connection, access_token_enc: null };
    // Re-read the refreshed credential from storage on the retry.
    const { getConnection } = await import('../domain/connections.ts');
    return graph<T>(getConnection(connection.id) ?? fresh, path, options, true);
  }

  if (res.status === 404 || res.status === 410) {
    throw new RemoteGoneError(`Microsoft event is gone (${res.status})`);
  }

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new NeedsReauthError(`Microsoft denied access (${res.status}): ${text.slice(0, 200)}`);
    }
    throw new Error(`Graph ${options.method ?? 'GET'} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = res.status === 204 ? ({} as T) : ((await res.json()) as T);
  return { status: res.status, data };
}

interface GraphEvent {
  id: string;
  '@odata.etag'?: string;
}

function body(ctx: PushContext, includeCreateOnlyFields: boolean): Record<string, unknown> {
  const { event } = ctx;
  const payload: Record<string, unknown> = {
    subject: event.title,
    body: { contentType: 'HTML', content: event.description ?? '' },
    location: { displayName: event.location ?? '' },
    start: { dateTime: event.starts_at, timeZone: event.timezone },
    end: { dateTime: event.ends_at, timeZone: event.timezone },
  };

  if (includeCreateOnlyFields) {
    // transactionId lets Graph collapse duplicate POSTs if we retry a create whose
    // response we never saw. It cannot be changed afterwards, so it is create-only.
    payload.transactionId = deterministicKey(ctx.event.id, ctx.connection.id);
    payload.singleValueExtendedProperties = [
      { id: uidPropertyId(), value: event.ical_uid },
    ];
  }

  return payload;
}

export const microsoftProvider: CalendarProvider = {
  id: 'microsoft',
  label: 'Microsoft Outlook',

  async push(ctx: PushContext): Promise<PushResult> {
    if (ctx.target.external_event_id) {
      const res = await graph<GraphEvent>(
        ctx.connection,
        `/me/events/${encodeURIComponent(ctx.target.external_event_id)}`,
        { method: 'PATCH', body: body(ctx, false) },
      );
      return { externalId: res.data.id, etag: res.data['@odata.etag'] ?? null };
    }

    const existing = await findByUid(ctx).catch(() => null);
    if (existing) {
      const res = await graph<GraphEvent>(
        ctx.connection,
        `/me/events/${encodeURIComponent(existing.externalId)}`,
        { method: 'PATCH', body: body(ctx, false) },
      );
      return { externalId: res.data.id, etag: res.data['@odata.etag'] ?? null };
    }

    const res = await graph<GraphEvent>(ctx.connection, '/me/events', {
      method: 'POST',
      body: body(ctx, true),
    });
    return { externalId: res.data.id, etag: res.data['@odata.etag'] ?? null };
  },

  async remove(ctx: PushContext): Promise<void> {
    if (!ctx.target.external_event_id) return;
    try {
      await graph(
        ctx.connection,
        `/me/events/${encodeURIComponent(ctx.target.external_event_id)}`,
        { method: 'DELETE' },
      );
    } catch (err) {
      if (err instanceof RemoteGoneError) return;
      throw err;
    }
  },
};

/** Find a previously created copy via the extended property carrying our UID. */
async function findByUid(ctx: PushContext): Promise<PushResult | null> {
  const filter = `singleValueExtendedProperties/any(ep:ep/id eq '${uidPropertyId()}' and ep/value eq '${ctx.event.ical_uid}')`;
  const res = await graph<{ value: GraphEvent[] }>(
    ctx.connection,
    `/me/events?$filter=${encodeURIComponent(filter)}&$select=id&$top=1`,
  );
  const found = res.data.value?.[0];
  return found ? { externalId: found.id, etag: found['@odata.etag'] ?? null } : null;
}

export async function microsoftAccountEmail(token: string): Promise<string | null> {
  try {
    const res = await fetch(`${GRAPH}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { mail?: string; userPrincipalName?: string };
    return data.mail ?? data.userPrincipalName ?? null;
  } catch {
    return null;
  }
}
