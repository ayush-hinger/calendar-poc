export type ProviderId = 'google' | 'microsoft' | 'apple' | 'log';

export interface User {
  id: string;
  role: 'teacher' | 'student';
  name: string;
  email: string | null;
}

export interface Connection {
  id: string;
  user_id: string;
  provider: ProviderId;
  account_email: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  expires_at: number | null;
  caldav_base_url: string | null;
  caldav_calendar_url: string | null;
  status: 'active' | 'needs_reauth' | 'revoked';
  last_error: string | null;
}

export interface ClassEvent {
  id: string;
  teacher_id: string;
  title: string;
  description: string | null;
  location: string | null;
  /** ISO-8601 local wall time, e.g. 2026-11-10T09:00:00 */
  starts_at: string;
  ends_at: string;
  timezone: string;
  status: 'scheduled' | 'cancelled';
  version: number;
  ical_uid: string;
}

export interface SyncTarget {
  id: string;
  event_id: string;
  connection_id: string;
  external_event_id: string | null;
  external_etag: string | null;
  synced_version: number;
  state: 'pending' | 'synced' | 'failed' | 'dead' | 'removed';
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
}

/** Raised by adapters when the remote copy is gone and must be recreated. */
export class RemoteGoneError extends Error {}

/** Raised when the stored credential can no longer be used without the student re-connecting. */
export class NeedsReauthError extends Error {}
