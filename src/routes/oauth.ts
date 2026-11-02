import { Router } from 'express';
import crypto from 'node:crypto';
import { config, googleConfigured, microsoftConfigured, redirectUri } from '../config.ts';
import { db } from '../db.ts';
import { upsertConnection } from '../domain/connections.ts';
import { materializeTargets } from '../domain/events.ts';
import {
  GOOGLE_SCOPES,
  googleAccountEmail,
  googleOAuthClient,
} from '../providers/google.ts';
import {
  MICROSOFT_SCOPES,
  microsoftAccountEmail,
  microsoftAuthority,
} from '../providers/microsoft.ts';
import { discoverCalendars } from '../providers/apple.ts';

export const oauthRouter = Router();

/** Short-lived CSRF state -> student id. In-process is fine for a single-node POC. */
const pendingStates = new Map<string, { studentId: string; at: number }>();

function issueState(studentId: string): string {
  const state = crypto.randomBytes(16).toString('base64url');
  pendingStates.set(state, { studentId, at: Date.now() });
  // Drop anything older than 10 minutes.
  for (const [k, v] of pendingStates) {
    if (Date.now() - v.at > 600_000) pendingStates.delete(k);
  }
  return state;
}

function consumeState(state: unknown): string | null {
  if (typeof state !== 'string') return null;
  const entry = pendingStates.get(state);
  if (!entry) return null;
  pendingStates.delete(state);
  return entry.studentId;
}

/**
 * A newly connected calendar must receive the classes the student is already
 * enrolled in, so we materialize targets; the worker then backfills them.
 */
function backfill(studentId: string): void {
  const events = db
    .prepare(
      `SELECT event_id FROM enrollments e
         JOIN class_events c ON c.id = e.event_id
        WHERE e.student_id = ? AND c.status = 'scheduled'`,
    )
    .all(studentId) as Array<{ event_id: string }>;
  for (const { event_id } of events) materializeTargets(event_id);
}

function done(res: import('express').Response, studentId: string, message: string): void {
  res.redirect(`/student/${studentId}?notice=${encodeURIComponent(message)}`);
}

function fail(res: import('express').Response, message: string): void {
  res.status(400).send(
    `<h1>Connection failed</h1><pre>${message.replace(/[<>&]/g, '')}</pre><p><a href="/">Back</a></p>`,
  );
}

// ---------------------------------------------------------------- Google

oauthRouter.get('/connect/google', (req, res) => {
  if (!googleConfigured) return fail(res, 'Google is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env');
  const studentId = String(req.query.student ?? '');
  if (!studentId) return fail(res, 'Missing ?student=<id>');

  const url = googleOAuthClient().generateAuthUrl({
    // offline + consent is what guarantees a refresh token on every connect,
    // including repeat connects of an account that already granted access.
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_SCOPES,
    state: issueState(studentId),
  });
  res.redirect(url);
});

oauthRouter.get('/oauth/google/callback', async (req, res) => {
  const studentId = consumeState(req.query.state);
  if (!studentId) return fail(res, 'Invalid or expired OAuth state');
  if (req.query.error) return fail(res, `Google returned: ${String(req.query.error)}`);

  try {
    const client = googleOAuthClient();
    const { tokens } = await client.getToken(String(req.query.code));
    client.setCredentials(tokens);

    const email = await googleAccountEmail(client);
    upsertConnection({
      user_id: studentId,
      provider: 'google',
      account_email: email,
      access_token: tokens.access_token ?? null,
      refresh_token: tokens.refresh_token ?? null,
      expires_at: tokens.expiry_date ?? null,
    });
    backfill(studentId);
    done(res, studentId, `Google Calendar connected${email ? ` (${email})` : ''}`);
  } catch (err) {
    fail(res, err instanceof Error ? err.message : String(err));
  }
});

// ------------------------------------------------------------- Microsoft

oauthRouter.get('/connect/microsoft', (req, res) => {
  if (!microsoftConfigured) return fail(res, 'Microsoft is not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in .env');
  const studentId = String(req.query.student ?? '');
  if (!studentId) return fail(res, 'Missing ?student=<id>');

  const params = new URLSearchParams({
    client_id: config.MICROSOFT_CLIENT_ID ?? '',
    response_type: 'code',
    redirect_uri: redirectUri('microsoft'),
    response_mode: 'query',
    scope: MICROSOFT_SCOPES.join(' '),
    state: issueState(studentId),
    prompt: 'select_account',
  });
  res.redirect(`${microsoftAuthority()}/authorize?${params}`);
});

oauthRouter.get('/oauth/microsoft/callback', async (req, res) => {
  const studentId = consumeState(req.query.state);
  if (!studentId) return fail(res, 'Invalid or expired OAuth state');
  if (req.query.error) {
    return fail(res, `Microsoft returned: ${String(req.query.error_description ?? req.query.error)}`);
  }

  try {
    const tokenRes = await fetch(`${microsoftAuthority()}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.MICROSOFT_CLIENT_ID ?? '',
        client_secret: config.MICROSOFT_CLIENT_SECRET ?? '',
        grant_type: 'authorization_code',
        code: String(req.query.code),
        redirect_uri: redirectUri('microsoft'),
        scope: MICROSOFT_SCOPES.join(' '),
      }),
    });

    const data = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error_description?: string;
    };
    if (!tokenRes.ok || !data.access_token) {
      return fail(res, `Token exchange failed: ${data.error_description ?? tokenRes.status}`);
    }

    const email = await microsoftAccountEmail(data.access_token);
    upsertConnection({
      user_id: studentId,
      provider: 'microsoft',
      account_email: email,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? null,
      expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    });
    backfill(studentId);
    done(res, studentId, `Outlook connected${email ? ` (${email})` : ''}`);
  } catch (err) {
    fail(res, err instanceof Error ? err.message : String(err));
  }
});

// ----------------------------------------------------------------- Apple

/** Apple has no OAuth: the student pastes an app-specific password instead. */
oauthRouter.post('/connect/apple', async (req, res) => {
  const { student, appleId, appPassword, calendarUrl } = req.body ?? {};
  if (!student || !appleId || !appPassword) {
    return res.status(400).json({ error: 'student, appleId and appPassword are required' });
  }

  try {
    const { calendars } = await discoverCalendars(appleId, appPassword);
    const chosen =
      (typeof calendarUrl === 'string' && calendars.find((c) => c.url === calendarUrl)) ||
      calendars[0]!;

    upsertConnection({
      user_id: student,
      provider: 'apple',
      account_email: appleId,
      // The app-specific password is the long-lived credential; it has no expiry.
      access_token: appPassword,
      expires_at: null,
      caldav_base_url: 'https://caldav.icloud.com',
      caldav_calendar_url: chosen.url,
    });
    backfill(student);

    res.json({
      ok: true,
      calendar: chosen,
      available: calendars,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
