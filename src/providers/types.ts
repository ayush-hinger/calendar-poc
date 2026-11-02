import type { ClassEvent, Connection, ProviderId, SyncTarget } from '../domain/types.ts';

export interface PushContext {
  connection: Connection;
  event: ClassEvent;
  target: SyncTarget;
}

export interface PushResult {
  externalId: string;
  etag?: string | null;
}

export interface CalendarProvider {
  readonly id: ProviderId;
  readonly label: string;

  /**
   * Upsert the class into this calendar: create when the target has no external
   * id, otherwise update in place. Keeping this a single operation is what lets
   * the sync engine treat "first push" and "edit" identically.
   */
  push(ctx: PushContext): Promise<PushResult>;

  /** Remove the copy from this calendar. Must be a no-op if already gone. */
  remove(ctx: PushContext): Promise<void>;
}
