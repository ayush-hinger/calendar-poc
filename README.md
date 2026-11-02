# Cross-provider calendar sync — POC

A teacher schedules one class. Every enrolled student sees it in their own
calendar — Google, Outlook, or Apple iCloud — and when the teacher edits or
cancels it, every copy follows.

```bash
pnpm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # paste as ENCRYPTION_KEY
pnpm seed        # optional: three students on simulated calendars, one class
pnpm dev         # http://localhost:3000
```

`pnpm seed` needs no credentials. It demonstrates the whole engine — fan-out,
an edit propagating, a failing calendar retrying on its own — before you connect
anything real.

## How it works

The platform is the system of record. Each class carries a monotonically
increasing `version`, and each (class × student calendar) pair is a row in
`sync_targets` with a `synced_version`. The entire engine follows from one rule:

> **a target whose `synced_version` is behind the event's `version` has work pending.**

Create, edit and cancel all do the same thing — mutate the row and bump the
version. A worker ([`src/sync/worker.ts`](src/sync/worker.ts)) polls for lagging
targets and drives each one forward.

Consequences worth knowing, because they are the reason it is built this way:

- **Retries are free.** Every adapter's `push` is an upsert keyed on a stable
  identity, so replaying a push converges instead of duplicating.
- **Crashes self-heal.** Pending work *is* the table, not an in-memory queue, so
  restarting mid-fan-out resumes with no extra bookkeeping.
- **Partial failure is visible.** One student's revoked token shows up as a
  `failed` row with the provider's error, and does not hold up anyone else.
- **Reconciliation needs no special path.** "Re-push all" just rewinds
  `synced_version` to 0, which is the same signal an edit produces.

### Shared identity across providers

Every copy shares one iCalendar UID, `<eventId>@calendar-poc`:

| Provider  | How the UID travels | Create | Update |
|-----------|--------------------|--------|--------|
| Google    | native `iCalUID` | `events.import` | `events.patch` |
| Microsoft | `singleValueExtendedProperties` (its `iCalUId` is **read-only**) | `POST /me/events` + `transactionId` | `PATCH /me/events/{id}` |
| Apple     | native `UID` in the `.ics` | `PUT` with `If-None-Match: *` | `PUT` with `If-Match: <etag>` |

Three details that drove the design:

- Google's **`events.import`** — not `events.insert` — is the documented way to
  "add a private copy of an existing event to a calendar", and it requires a
  caller-supplied `iCalUID`. Importing twice with the same UID updates rather
  than duplicating, which is what makes the retry loop safe.
- Outlook's `iCalUId` is read-only, so the UID lives in a named extended
  property instead. `transactionId` lets Graph collapse a duplicate POST whose
  response we never saw, and `Prefer: IdType="ImmutableId"` keeps our stored id
  valid if the event is moved between folders.
- Apple has **no OAuth and no REST calendar API**. iCloud is CalDAV with Basic
  auth and an app-specific password, and discovery redirects to a regional host
  (`p42-caldav.icloud.com`), which is persisted per connection.

## Connecting real accounts

Open `/student/<id>`, or follow **Students** from the teacher console. Buttons
for unconfigured providers are disabled.

**Google** — Cloud Console → enable Calendar API → OAuth client (Web):
- redirect URI `http://localhost:3000/oauth/google/callback`
- scope `.../auth/calendar.events`
- add each test student under **Audience → Test users**

**Microsoft** — Entra ID → App registrations:
- redirect URI (Web) `http://localhost:3000/oauth/microsoft/callback`
- delegated permissions `Calendars.ReadWrite`, `offline_access`
- keep `MICROSOFT_TENANT=common` to allow personal accounts

**Apple** — each student generates a 16-character app-specific password at
account.apple.com → Sign-In and Security → App-Specific Passwords, and pastes it
with their Apple ID. The normal Apple Account password will not work.

Refresh tokens and app passwords are encrypted at rest with AES-256-GCM
(`ENCRYPTION_KEY`). Without that key the app still runs, but stores them in
plaintext and says so at startup.

## Expected behaviour that looks like a bug

- **Google Testing-mode consent expires after 7 days**, taking refresh tokens
  with it, so a demo that worked last week needs reconnecting. Unverified
  projects are also capped at 100 users for their lifetime.
- **Apple revokes every app-specific password** when the student changes their
  main Apple Account password.
- Students get a **copy**, not an invitation — there is no RSVP. That is
  deliberate: it is what makes behaviour identical across all three providers.
- A student's own edits to their copy are **overwritten** on the next push.
- **Recurring classes are out of scope.** One class is one event. The schema
  leaves room (`rrule` column plus adapter work) without touching the engine.

## API

| | |
|---|---|
| `POST /api/events` | schedule a class and fan out |
| `PATCH /api/events/:id` | edit → bump version → propagate |
| `POST /api/events/:id/cancel` | delete the copy everywhere |
| `GET /api/events/:id/targets` | per-calendar convergence state (the UI polls this) |
| `POST /api/events/:id/reconcile` | re-push every copy, repairing drift |
| `POST /api/events/:id/retry` | requeue failed and dead targets |
| `POST /api/students/:id/simulate` | attach a fake calendar; label it `fail…` to force errors |

```bash
curl -s localhost:3000/api/events/<id>/targets | jq
```

## Layout

```
src/
  domain/      events + connections (version bumping lives here)
  sync/        engine (one target -> current version), worker, reconcile
  providers/   google · microsoft · apple (CalDAV) · log, behind one interface
  routes/      api + oauth
  web/         teacher console, student page
  time.ts      wall-time -> UTC, DST-correct (CalDAV needs real instants)
```
