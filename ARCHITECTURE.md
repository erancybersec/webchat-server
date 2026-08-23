# Architecture

Greenfield rewrite of a WhatsApp manager that previously lived in a single
479 KB `index.html` talking to the Evolution API directly from the browser.
The defining decision: **the frontend talks only to `/api`** — the Evolution
base URL and API key exist exclusively on the server.

```
   ┌────────────────────────────┐
   │   frontend/  (React SPA)   │  Vite + TS + Tailwind + react-query
   └─────────────┬──────────────┘
                 │  /api only (fetch + SSE)
   ┌─────────────┴──────────────┐
   │   backend/   native API    │  Fastify
   │                            │
   │  jobs · blacklist · send   │──► domain core: services/ + db/ (SQLite)
   │  chats · contacts ·        │
   │  messages · media          │──► typed Evolution gateway (apikey here)
   │  events (SSE)              │──► EventRelay ◄── Evolution websocket
   └────────────────────────────┘
```

## Backend

- **Send ledger** (`job_sends`): every recipient × item of a job is
  one row, marked `sent`/`skipped`/`failed` individually. A crash or restart
  flips interrupted jobs back to pending and the re-run **resumes** — it never
  resends rows already marked sent. Transient failures retry up to
  `SEND_MAX_ATTEMPTS` within a run. `GET /api/jobs/:id/sends` exposes the rows.
- **One send pipeline.** Compose "Send Now" and the Groups broadcast create a
  job too (`type: 'immediate'`, due now) — saving a due job wakes the scheduler
  so it fires without waiting out the poll. The browser only watches the ledger,
  so an immediate send survives a closed tab and lands in history like any run.
  `POST /api/jobs/:id/rerun` resends a finished job by cloning it as immediate.
- **Campaign control** (v2.31): a job can be **paused** and continued — a new
  `paused` status plus `POST /api/jobs/:id/pause` | `/resume`. Pausing a running
  job stops it after the send in flight (the scheduler re-reads the status
  between sends); every unsent ledger row stays `pending`, so continuing picks
  up exactly there and nobody is messaged twice. `/resume` also covers a job
  stopped mid-campaign and one waiting out a batch pause ("continue now"), and
  it is deliberately **not** re-approved — the job was released once already.
  Pacing lives in a nullable `jobs.batch` JSON column (`BatchRule`), two
  independent halves: a **sending window** (`pauseAt`/`resumeAt`, "run until
  21:00, continue at 09:00") and **batches** (`size` wire attempts, then
  `pauseMin` minutes or a human Continue). Both leave `running` without
  finalizing, which is the same resume path crash recovery already used. A
  campaign that has begun also respects quiet hours, even an immediate one.
  `GET /api/jobs/:id/progress` reports counts/rate/ETA/next-run **from the
  ledger** (exact after a refresh or restart), and `GET /api/jobs/:id/sends/page`
  serves one filtered page of the per-recipient log — whose filter the CSV export
  takes too, so "failed only" downloads the failed only.
  `POST /api/jobs/:id/retry-failed` returns the failed rows (only those) to the
  queue, and `POST /api/jobs/:id/unsent-list` saves the failed + never-attempted
  recipients as an ordinary **recipient list** (names carried over from the job,
  so `{{name}}` still works) — the "send to them another day" path, as opposed to
  retrying this job's own sequence now. **A paused campaign can be edited**: same-shaped sequence and any recipient set, with sent rows kept —
  only the not-yet-sent get the new text (item count is refused with 409, since
  ledger rows key on the item index).
- **Job scopes**: `GET /api/jobs?scope=scheduled|history` serves one page
  (`limit`/`offset`, per-status counts for the filter chips) so lists of
  hundreds of jobs never ship to the browser whole. `scheduled` = the upcoming
  queue; `history` = finished jobs plus all immediate sends. A `paused` job
  stays in whichever list it belongs to and survives every bulk clear.
- **Blacklist** is enforced at the single send choke point (`Sender.sendOne`),
  with identical phone normalization on both sides of the wire. Groups are
  never blocked.
- **Number verification** (`services/verification.ts`) is a *cache*, kept in a
  separate table from the blacklist on purpose: the blacklist is a policy a
  person authored, this is an observation WhatsApp handed us that expires on its
  own and is sometimes wrong. A campaign kicks a sweep off through
  `POST /chat/whatsappNumbers` and **starts sending immediately** — the sweep is
  a background drip that never gates the campaign. Verdicts are cached (valid
  180d, invalid 90d — the asymmetry is deliberate: being wrong about `invalid`
  costs a real customer for the whole window, being wrong about `valid` costs
  one failed send), so campaigns skip an *already* known-dead number as a
  settled `skipped` row instead of burning `sendMaxAttempts` on a rejection that
  can never succeed; a number nobody has asked about yet simply sends, and its
  own 400 settles it in one attempt. **1:1 chat is never gated** — a stale
  verdict or a lookup outage must not lock an agent out of a live conversation.
  A *throttle breaker* guards the cache: WhatsApp answers `exists:false` for
  live numbers while rate-limiting, so invalid verdicts are buffered and only
  committed once a live number proves the run was scattered; `verifyBreakerRun`
  consecutive rejections discards the run and stops the sweep (it does *not*
  stop the campaign — the breaker is about what we may believe, not about
  whether we may send).
  ⚠️ **Why the drip, and not a fast pre-flight:** awaiting the sweep meant it had
  to finish before the first message could go out, so it had to be fast — and
  1,045 existence lookups inside 40 seconds is indistinguishable from contact
  scraping. Decoupled, it can take hours and nobody minds. Defaults are paced
  accordingly (`VERIFY_BATCH_SIZE=10`, `VERIFY_BATCH_PAUSE_MS=60000`) under a
  per-day ceiling (`VERIFY_DAILY_CAP`) metered off `checked_at` in the cache, so
  a restart cannot reset the budget.
- **Cold-contact cap** (`services/quota.ts` + `services/familiarity.ts`,
  migration 020) rations **first contact only**. `known_contacts` records who a
  line actually has a conversation with, per instance; every recipient is
  classified `group` / `known` / `cold`, and only `cold` spends the budget. The
  unit is one cold *recipient* per rolling 24h, not one message — a multi-item
  sequence is one stranger hearing from you, and a sequence is never split
  across the cap boundary. The ceiling starts at `COLD_WARMUP_START` and doubles
  per earlier day of cold outreach up to `COLD_DAILY_CAP`; counting distinct
  days means the ramp tracks demonstrated behavior and a quiet month starts
  gently again. Over-budget rows are left **pending** and the job is re-queued
  for `resumeAt` (default 09:00) — never marked failed, since the ration has
  nothing to do with the recipient. Warm recipients keep flowing even after the
  cold budget is spent.
  - What deliberately does **not** make someone known: us messaging them. Only
    an inbound message, or the one-time bootstrap seed from Evolution's chat
    list at first boot, does. Otherwise a cold list would launder itself one
    daily allowance at a time. The seed matters: without it, switching the cap
    on would classify years of existing contacts as strangers.
  - ⚠️ On this deployment every incoming direct message arrives under the
    contact's `@lid`, so the relay listener resolves it via `ChatMetaStore.canon`
    before filing; an unresolved `@lid` is dropped rather than filed under its
    own digits, which are not a phone number.
- **Disconnect guard.** The send loop checks the line's `connectionStatus`
  before the first message and every 60s after (immediately after 3 consecutive
  failures), and pauses the job with "the WhatsApp line is disconnected" rather
  than firing into a severed session and burning `sendMaxAttempts` per recipient
  on an outcome that cannot change. An unknown or unreachable status never
  blocks a send — only an explicit non-`open`.
- `GET /api/sending-limits` reports today's ration, what is left of it, the
  known-contact count and the verification pacing, so a paused campaign can be
  explained without a shell.
- **Typed gateway, not a proxy.** Each `/api` route maps to one specific
  Evolution endpoint. There is deliberately no generic
  `{endpoint, body}` tunnel.
- **EventRelay**: the server holds one upstream socket.io connection to
  Evolution and fans events out to browsers over SSE (`/api/events`) —
  one-way flow, free reconnection via `EventSource`.
- **Roles** (admin/agent, on top of the v2.6 agent identification): permission
  keys live in `services/authz.ts` — routes name a `PermissionKey`, the
  `can(agent, key)` helper maps it to roles, and per-agent overrides would plug
  into `can()` alone. Admin-only today: `PUT /api/settings`,
  `POST /api/settings/test`, `GET /api/analytics/summary`,
  `PUT /api/agents/:email`. Enforcement is skipped while the identification
  toggle is off or when a request carries no Cloudflare Access identity
  (LAN/bearer/automation — Access is the perimeter). The first agent ever seen
  becomes admin; the last admin cannot be demoted.
- **Event envelope**: Evolution's global websocket wraps every payload in
  `{instance, data}`. `services/envelope.ts#unwrapEvent` is the single seam
  that flattens it (plus bare records, arrays, `{messages:[…]}`) — every
  backend listener (acks, opt-out, chat watcher, message stats) goes through
  it. The SSE stream still carries the envelope verbatim; the frontend
  unwraps with the same rules in `useEvents`.
- **Multi-instance** (v2.9): one Evolution server hosts several instances
  (WhatsApp lines). `agents.instances` grants per agent (admins see all;
  no grants = the Settings default). Every Evolution-touching route resolves
  `?instance=` through `InstanceAccess` — names are charset-validated for
  everyone (they're interpolated into Evolution URL paths), grants enforced
  for identified non-admin agents. Jobs are pinned to their instance through
  edit/restore/rerun/roll-forward; the SSE route filters Evolution events
  per connection by grants (app events pass by explicit allowlist). Opt-out
  and the chat watcher act on the default instance only — the blacklist and
  the jid-keyed chat meta are global. Known accepted limitation: chat
  meta/read marks shared for the same jid across instances.
- **Message activity stats**: relay-fed daily counters
  (`message_stats` / `message_stat_chats`) bucketed by the message's own
  timestamp with a 7-day replay horizon — this is what makes Insights
  reflect chat traffic, not just the job ledger. Counts exist from v2.9 on.
- **Maintenance**: `GET /api/maintenance` (disk statfs of the data dir,
  DB+WAL size, table counts, Evolution per-instance Message/Chat counts) and
  `POST /api/maintenance/cleanup` (dry-run preview; deletes finished jobs +
  ledger, old attributions, fired reminders; VACUUM manual-only and refused
  while a job runs). `retention_days` setting drives a once-daily scheduler
  sweep. Insights shows the server-health card; Settings holds the controls.
- SQLite in WAL mode, ordered migrations applied at boot, zero external
  services. Proportional to a single-business deployment by design.

## Frontend

React SPA, no router dependency (tab state), react-query for all data.
Evolution record shapes pass through the gateway loosely typed (`EvoChat`,
`EvoMessage`) and are normalized defensively at the component edge — Evolution
versions vary and the UI must not crash on shape drift.

## Verification stance

The v1 file's hard-won lessons (this list is the porting backlog): `.enc`
media decryption, `@lid` → real-number alias resolution, numeric-vs-string
timestamp sorting (the NaN reshuffle bug), socket reconnection, mobile `100dvh`
keyboard pinning. Domain logic is covered by fast tests with a faked Evolution
(`backend/test/`); the chat model's pure functions (timestamp coercion, @lid
dedup/aliasing) have their own suite in `frontend/test/` — both run in CI.
**Chat parity can only be proven against a live instance** — read-only
endpoints are safe to verify headlessly, send paths need a real phone.

## Status

All planned milestones (M1–M4: v1 parity, live events, cutover) are done.
The app is in production on the studio host since 2026-06-12. v2.9.x shipped
v1 parity plus send history, server-side quick replies, recipient lists/table
with `{{name}}`/`{{wa_name}}` templates, recurring jobs, auto opt-out,
delivery/read acks, Insights (incl. live chat-traffic counters and per-agent
activity), presence, live job progress, quiet hours, the v2.8 agent workbench
(roles/permissions, approval, chat assignment/status/tags/notes, reminders),
multi-instance with per-agent instance grants, and storage maintenance with
retention.

v2.10 (code in, deploy pending): a `jobs.clearHistory` permission so agents
can't wipe job history; Insights custom date ranges (`from`/`to` alongside the
day presets) and a per-channel estimated chat-message disk size; reactions
collapsed to WhatsApp's one-per-sender semantics (latest wins, removal clears)
with a who/when tooltip; honest delivery-tick tooltip (read receipts may be
off, so "delivered" ≠ unread); a scrollable mobile tab strip; and the UI-wide
rename of "line" → "channel". The Insights tab now sits beside Settings.

**Web Push** (v2.10): real mobile notifications with the app closed — the
page-driven path (`useEvents` → `notifyMessage`) only fires while the tab is
alive, which the OS kills the moment a phone backgrounds it. A VAPID keypair is
generated once and persisted in SQLite (`push_keys`), browsers subscribe via
`PushManager` and POST the subscription to `/api/push/subscribe`
(`push_subscriptions`), and a relay listener (`attachPushNotifier`) pushes on
each inbound message — keyed to chat assignment like the in-page notifier
(assigned → its agent; unassigned → everyone), default instance only. The
service worker's `push` handler shows the notification unless a client is
focused (the in-page path covers that, avoiding doubles). iOS needs the PWA
installed to the home screen (iOS 16.4+).

Live events are ON: `WEBSOCKET_ENABLED=true` + `WEBSOCKET_GLOBAL_EVENTS=true`
on the Evolution container; the relay connects in global mode and the UI
updates over SSE, with polling refetch as the fallback if the socket drops.

Deploy procedure, history, rollback, and remaining post-cutover QA items
live in [deploy/README.md](deploy/README.md).
