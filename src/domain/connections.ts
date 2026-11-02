import { db } from '../db.ts';
import { encrypt, decrypt, randomId } from '../crypto.ts';
import type { Connection, ProviderId } from './types.ts';

export function getConnection(id: string): Connection | undefined {
  return db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as
    | Connection
    | undefined;
}

export function accessToken(c: Connection): string | null {
  return decrypt(c.access_token_enc);
}

export function refreshToken(c: Connection): string | null {
  return decrypt(c.refresh_token_enc);
}

export function saveTokens(
  id: string,
  tokens: { access_token?: string | null; refresh_token?: string | null; expires_at?: number | null },
): void {
  const current = getConnection(id);
  if (!current) return;

  db.prepare(
    `UPDATE connections
        SET access_token_enc = ?, refresh_token_enc = ?, expires_at = ?,
            status = 'active', last_error = NULL
      WHERE id = ?`,
  ).run(
    tokens.access_token !== undefined
      ? encrypt(tokens.access_token)
      : current.access_token_enc,
    // Providers often omit the refresh token on refresh -- never clobber it with null.
    tokens.refresh_token ? encrypt(tokens.refresh_token) : current.refresh_token_enc,
    tokens.expires_at !== undefined ? tokens.expires_at : current.expires_at,
    id,
  );
}

export function markNeedsReauth(id: string, message: string): void {
  db.prepare(
    `UPDATE connections SET status = 'needs_reauth', last_error = ? WHERE id = ?`,
  ).run(message, id);
}

/**
 * One connection per (user, provider, account). Re-connecting the same account
 * refreshes the credential in place rather than creating a duplicate, so the
 * existing sync_targets keep pointing at the right calendar.
 */
export function upsertConnection(input: {
  user_id: string;
  provider: ProviderId;
  account_email: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  expires_at?: number | null;
  caldav_base_url?: string | null;
  caldav_calendar_url?: string | null;
}): Connection {
  const existing = db
    .prepare(
      `SELECT * FROM connections
        WHERE user_id = ? AND provider = ? AND IFNULL(account_email,'') = IFNULL(?,'')`,
    )
    .get(input.user_id, input.provider, input.account_email) as
    | Connection
    | undefined;

  if (existing) {
    saveTokens(existing.id, {
      access_token: input.access_token,
      refresh_token: input.refresh_token,
      expires_at: input.expires_at,
    });
    if (input.caldav_base_url || input.caldav_calendar_url) {
      db.prepare(
        `UPDATE connections SET caldav_base_url = ?, caldav_calendar_url = ? WHERE id = ?`,
      ).run(
        input.caldav_base_url ?? existing.caldav_base_url,
        input.caldav_calendar_url ?? existing.caldav_calendar_url,
        existing.id,
      );
    }
    return getConnection(existing.id)!;
  }

  const id = randomId('con');
  db.prepare(
    `INSERT INTO connections
       (id, user_id, provider, account_email, access_token_enc, refresh_token_enc,
        expires_at, caldav_base_url, caldav_calendar_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.user_id,
    input.provider,
    input.account_email,
    encrypt(input.access_token),
    encrypt(input.refresh_token),
    input.expires_at ?? null,
    input.caldav_base_url ?? null,
    input.caldav_calendar_url ?? null,
  );
  return getConnection(id)!;
}

export interface StudentWithConnections {
  id: string;
  name: string;
  email: string | null;
  connections: Array<{
    id: string;
    provider: ProviderId;
    account_email: string | null;
    status: string;
    last_error: string | null;
  }>;
}

export function listStudents(): StudentWithConnections[] {
  const students = db
    .prepare(`SELECT id, name, email FROM users WHERE role = 'student' ORDER BY name`)
    .all() as Array<{ id: string; name: string; email: string | null }>;

  const conns = db
    .prepare(
      `SELECT id, user_id, provider, account_email, status, last_error
         FROM connections ORDER BY provider`,
    )
    .all() as Array<{ user_id: string } & StudentWithConnections['connections'][number]>;

  return students.map((s) => ({
    ...s,
    connections: conns
      .filter((c) => c.user_id === s.id)
      .map(({ user_id: _u, ...rest }) => rest),
  }));
}
