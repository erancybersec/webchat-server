export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '001-init',
    sql: `
      CREATE TABLE jobs (
        id           TEXT PRIMARY KEY,
        scheduled_at TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        type         TEXT,
        recipients   TEXT NOT NULL,            -- JSON [{id, isGroup}]
        items        TEXT NOT NULL,            -- JSON [{type, data}]
        result       TEXT,
        created_at   TEXT NOT NULL,
        started_at   TEXT,
        finished_at  TEXT
      );
      CREATE INDEX idx_jobs_due ON jobs(status, scheduled_at);

      -- Per-recipient send ledger: one row per recipient x item. This is what
      -- makes jobs resumable after a crash without double-sending.
      CREATE TABLE job_sends (
        job_id     TEXT    NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        recipient  TEXT    NOT NULL,
        is_group   INTEGER NOT NULL DEFAULT 0,
        item_index INTEGER NOT NULL,
        status     TEXT    NOT NULL DEFAULT 'pending',  -- pending|sent|skipped|failed
        attempts   INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        sent_at    TEXT,
        PRIMARY KEY (job_id, recipient, item_index)
      );
      CREATE INDEX idx_job_sends_pending ON job_sends(job_id, status);

      CREATE TABLE blacklist (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_number    TEXT NOT NULL UNIQUE,
        name            TEXT NOT NULL DEFAULT '',
        added_date      TEXT NOT NULL,
        why_blacklisted TEXT NOT NULL DEFAULT ''
      );
    `,
  },
  {
    id: '002-settings',
    sql: `
      -- Operator-editable settings (Evolution credentials, send pacing).
      -- Rows here override env config at boot and at runtime via /api/settings.
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    id: '003-v24',
    sql: `
      -- Saved audiences: pick a whole list as recipients in Compose.
      CREATE TABLE recipient_lists (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE recipient_list_members (
        list_id   TEXT    NOT NULL REFERENCES recipient_lists(id) ON DELETE CASCADE,
        recipient TEXT    NOT NULL,            -- normalized phone or group JID
        is_group  INTEGER NOT NULL DEFAULT 0,
        name      TEXT    NOT NULL DEFAULT '', -- feeds {{name}} personalization
        PRIMARY KEY (list_id, recipient)
      );

      -- Quick replies move out of per-device localStorage so they survive
      -- browser changes and are shared across devices.
      CREATE TABLE quick_replies (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        shortcut   TEXT NOT NULL DEFAULT '',
        text       TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      -- Recurrence rule (JSON {freq, until?}) — NULL for one-shot jobs.
      ALTER TABLE jobs ADD COLUMN repeat TEXT;

      -- Delivery tracking: the Evolution message id of a sent row, matched
      -- against MESSAGES_UPDATE acks to fill delivered_at/read_at.
      ALTER TABLE job_sends ADD COLUMN message_id TEXT;
      ALTER TABLE job_sends ADD COLUMN delivered_at TEXT;
      ALTER TABLE job_sends ADD COLUMN read_at TEXT;
      CREATE INDEX idx_job_sends_message ON job_sends(message_id);
    `,
  },
  {
    id: '004-agents',
    sql: `
      -- Sales agents, auto-provisioned from the Cloudflare Access identity
      -- header on first request (the Access policy decides who can log in).
      CREATE TABLE agents (
        email        TEXT PRIMARY KEY,
        name         TEXT NOT NULL DEFAULT '',  -- display name, set in Settings
        color        TEXT NOT NULL DEFAULT '',  -- badge palette key, set in Settings
        active       INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      -- Who composed the job. NULL = created before tracking or while disabled.
      ALTER TABLE jobs ADD COLUMN sent_by TEXT;

      -- Chat-screen sends live in Evolution, not in jobs — attribute them by
      -- the Evolution message id the send call returns.
      CREATE TABLE message_agents (
        message_id  TEXT PRIMARY KEY,
        agent_email TEXT NOT NULL,
        sent_at     TEXT NOT NULL
      );
    `,
  },
  {
    id: '005-roles',
    sql: `
      -- Role-based access: 'admin' (full access incl. Settings/Insights) or
      -- 'agent'. Everyone existing at upgrade time is promoted to admin so
      -- nobody loses access — the admin demotes teammates in Settings.
      ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT 'agent';
      UPDATE agents SET role = 'admin';
    `,
  },
  {
    id: '006-v28',
    sql: `
      -- Per-agent permission overrides (JSON PermissionKey → bool). Absent
      -- key = the role's default; only explicit grants/denies are stored.
      ALTER TABLE agents ADD COLUMN perms TEXT NOT NULL DEFAULT '{}';

      -- Personal quick replies. NULL = shared with the whole team.
      ALTER TABLE quick_replies ADD COLUMN agent_email TEXT;

      -- Which chat a chat-screen send belonged to — feeds per-agent insights
      -- ("chats touched"). Only populated going forward; history stays NULL.
      ALTER TABLE message_agents ADD COLUMN chat_jid TEXT;

      -- WhatsApp assigns both @lid and @s.whatsapp.net JIDs to one contact.
      -- Server-side alias map so chat-keyed rows survive whichever jid an
      -- event or client happens to carry. Learned from clients (which dedup
      -- by profile pic etc.) and from remoteJidAlt on incoming events.
      CREATE TABLE jid_aliases (
        alt_jid     TEXT PRIMARY KEY,
        primary_jid TEXT NOT NULL
      );
      CREATE INDEX idx_jid_aliases_primary ON jid_aliases(primary_jid);

      -- Chat ownership: which agent a conversation belongs to.
      CREATE TABLE chat_assignments (
        chat_jid    TEXT PRIMARY KEY,
        agent_email TEXT NOT NULL,
        assigned_by TEXT NOT NULL DEFAULT '',
        assigned_at TEXT NOT NULL
      );

      -- Workflow status overlay (open|pending|resolved). Deliberately separate
      -- from read/unread, which keeps mimicking WhatsApp Web untouched.
      CREATE TABLE chat_status (
        chat_jid   TEXT PRIMARY KEY,
        status     TEXT NOT NULL DEFAULT 'open',
        changed_by TEXT NOT NULL DEFAULT '',
        changed_at TEXT NOT NULL
      );

      -- Internal agent-only notes on a chat — never enters any send path.
      CREATE TABLE chat_notes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_jid    TEXT NOT NULL,
        agent_email TEXT NOT NULL DEFAULT '',
        body        TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_chat_notes_jid ON chat_notes(chat_jid);

      CREATE TABLE chat_tags (
        chat_jid   TEXT NOT NULL,
        tag        TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (chat_jid, tag)
      );

      -- Follow-up reminders, fired by the scheduler poll.
      CREATE TABLE reminders (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_jid    TEXT NOT NULL,
        agent_email TEXT NOT NULL DEFAULT '',
        due_at      TEXT NOT NULL,
        note        TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'pending', -- pending|fired|dismissed
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_reminders_due ON reminders(status, due_at);
    `,
  },
  {
    id: '007-v29',
    sql: `
      -- Message activity counters, fed by the event relay (messages.upsert).
      -- This is what lets Insights reflect real chat traffic instead of only
      -- the job ledger. Counts exist from the v2.9 deploy onward.
      CREATE TABLE message_stats (
        day       TEXT NOT NULL,               -- UTC YYYY-MM-DD
        instance  TEXT NOT NULL DEFAULT '',
        direction TEXT NOT NULL,               -- 'in' | 'out'
        count     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, instance, direction)
      );
      -- Distinct chats active per day (the "active chats" insight).
      CREATE TABLE message_stat_chats (
        day      TEXT NOT NULL,
        instance TEXT NOT NULL DEFAULT '',
        chat_jid TEXT NOT NULL,
        PRIMARY KEY (day, instance, chat_jid)
      );

      -- Per-agent Evolution instance grants (JSON array of instance names).
      -- NULL/empty = the default instance from Settings only. Admins always
      -- see every instance.
      ALTER TABLE agents ADD COLUMN instances TEXT;

      -- Which Evolution instance a job sends through. NULL = the default
      -- instance at run time (pre-v2.9 jobs keep working unchanged).
      ALTER TABLE jobs ADD COLUMN instance TEXT;
    `,
  },
  {
    id: '008-v210',
    sql: `
      -- Web Push (Push API) subscriptions — one row per browser/device
      -- endpoint, so notifications reach a phone even when the app is closed
      -- (the page-driven path can't fire once the OS suspends the tab).
      -- agent_email empty = identification was off when subscribed (notify
      -- everyone). Rows are deleted when the push service reports the endpoint
      -- gone (404/410).
      CREATE TABLE push_subscriptions (
        endpoint    TEXT PRIMARY KEY,
        agent_email TEXT NOT NULL DEFAULT '',
        p256dh      TEXT NOT NULL,
        auth        TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_push_subs_agent ON push_subscriptions(agent_email);

      -- Single-row VAPID keypair, generated once on first boot so push works
      -- with no manual key config. The public key is handed to browsers to
      -- subscribe; the private key signs the push requests.
      CREATE TABLE push_keys (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        public_key  TEXT NOT NULL,
        private_key TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
    `,
  },
  {
    id: '009-msgcache',
    sql: `
      -- Last-known content of each message, snapshotted from the live event
      -- relay as messages arrive. This is the ONE place the server persists
      -- message bodies — everywhere else it only proxies Evolution live. The
      -- reason: a delete-for-everyone NULLS the content on Evolution's side, so
      -- the original text is unrecoverable from any later findMessages fetch.
      -- Caching it here lets the chat keep showing what a deleted message
      -- originally said. Pruned by the same retention sweep as the job ledger
      -- (Settings → retention days); kept forever when retention is 0, exactly
      -- like message_agents. Only messages seen after this deploy are covered.
      CREATE TABLE message_cache (
        message_id TEXT PRIMARY KEY,
        chat_jid   TEXT NOT NULL DEFAULT '',
        instance   TEXT NOT NULL DEFAULT '',
        type       TEXT NOT NULL DEFAULT 'text',
        text       TEXT NOT NULL DEFAULT '',
        caption    TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_message_cache_created ON message_cache(created_at);
    `,
  },
  {
    id: '010-msgdeletes',
    sql: `
      -- Who deleted a message for everyone, stamped when the delete goes through
      -- our app (agent identity from the Cloudflare Access header). Lets the chat
      -- show "Deleted by {agent}" instead of a bare tombstone — the shared inbox
      -- has many agents on one WhatsApp line, so "you deleted" is ambiguous.
      -- Deletes made on the phone (not via the app) have no row → no attribution.
      -- Low volume (one row per delete-for-everyone), so kept like message_stats.
      CREATE TABLE message_deletes (
        message_id  TEXT PRIMARY KEY,
        agent_email TEXT NOT NULL,
        chat_jid    TEXT NOT NULL DEFAULT '',
        deleted_at  TEXT NOT NULL
      );
    `,
  },
  {
    id: '011-msgedits',
    sql: `
      -- Prior versions of an edited message, oldest first. This Evolution build
      -- applies an edit IN PLACE (it overwrites the message content and only
      -- marks the MessageUpdate history 'EDITED' — there is no separate edit
      -- record), so the pre-edit text is unrecoverable from any later fetch. We
      -- snapshot it here from the live relay (see msgcache.ts): when a cached
      -- message's content changes, the old copy is pushed in as the next seq.
      -- This is what lets the chat show a clickable "Edited" with the previous
      -- versions, mirroring how message_cache restores deleted text. Pruned by
      -- the same retention sweep as message_cache; only edits seen after this
      -- deploy are covered.
      CREATE TABLE message_edits (
        message_id TEXT NOT NULL,
        seq        INTEGER NOT NULL,            -- 0,1,2… superseded versions, oldest first
        type       TEXT NOT NULL DEFAULT 'text',
        text       TEXT NOT NULL DEFAULT '',
        caption    TEXT NOT NULL DEFAULT '',
        edited_at  TEXT NOT NULL,
        PRIMARY KEY (message_id, seq)
      );
      CREATE INDEX idx_message_edits_at ON message_edits(edited_at);

      -- Who edited a message via our app (agent identity from the Cloudflare
      -- Access header), stamped after Evolution accepts the edit. Lets the chat
      -- show "Edited by {agent}" — the shared inbox has many agents on one line,
      -- so attribution matters. Mirror of message_deletes; edits made on the
      -- contact's own phone have no row (we can't know who on their side).
      CREATE TABLE message_editors (
        message_id  TEXT PRIMARY KEY,
        agent_email TEXT NOT NULL,
        chat_jid    TEXT NOT NULL DEFAULT '',
        edited_at   TEXT NOT NULL
      );
    `,
  },
  {
    id: '012-instance-scope',
    sql: `
      -- Per-instance separation for the surfaces that were still global. Jobs,
      -- message_stats and message_stat_chats already carry an instance; these
      -- two tables did not. NULL/'' is read as "the default instance" (the same
      -- rule jobs use at fire time: instance || cfg.evo.instance) — no backfill,
      -- so rows that predate this deploy surface under whatever the default
      -- instance is at view time.

      -- Which Evolution line a quick reply belongs to. Orthogonal to agent_email
      -- (personal vs team-shared still applies WITHIN the instance). New replies
      -- are pinned to the active instance; legacy rows (NULL) read as default.
      ALTER TABLE quick_replies ADD COLUMN instance TEXT;

      -- Which line a chat-screen send went through — lets per-agent Insights
      -- ("sends", "chats touched") split by instance. Populated going forward
      -- only; pre-deploy attributions stay NULL → counted under the default,
      -- exactly like the v2.8 chat_jid backfill gap.
      ALTER TABLE message_agents ADD COLUMN instance TEXT;
    `,
  },
  {
    id: '013-msgreads',
    sql: `
      -- When the recipient READ (or PLAYED) one of OUR sent messages, captured
      -- live from the MESSAGES_UPDATE ack relay. This Evolution build stores only
      -- a bare status string in the MessageUpdate history — no timestamp — so the
      -- read TIME is unrecoverable from any later findMessages fetch. We stamp it
      -- here the moment the ack arrives, the same way message_cache snapshots
      -- soon-to-be-deleted content. First ack wins (INSERT OR IGNORE): a re-read
      -- must not move the original "seen" time. The findMessages proxy attaches
      -- it back onto each record as 'readAt'; the chat then shows "Seen at HH:MM"
      -- instead of a bare blue tick. Only reads seen after this deploy are
      -- covered; pruned by the same retention sweep as message_cache.
      CREATE TABLE message_reads (
        message_id TEXT PRIMARY KEY,
        read_at    TEXT NOT NULL
      );
      CREATE INDEX idx_message_reads_at ON message_reads(read_at);
    `,
  },
  {
    id: '014-chatunread',
    sql: `
      -- Shared, server-side unread state per chat per line. Evolution's findChats
      -- unreadCount is unreliable on this deployment (comes back null/0 even for a
      -- freshly arrived incoming message — the account is also read on the phone,
      -- which clears the protocol-level unread). This is the team's source of
      -- truth instead: the relay bumps last_incoming_ts when an incoming message
      -- arrives; the read/unread endpoints move last_read_ts. A chat is unread for
      -- EVERY agent when last_incoming_ts > last_read_ts, so when one agent opens
      -- it the badge clears for all. Keyed by the canonical chat jid (chatMeta) so
      -- @lid/phone aliases collapse to one row. Only messages seen live after this
      -- deploy are tracked; untracked chats fall back to Evolution's count. Pruned
      -- by the retention sweep.
      CREATE TABLE chat_unread (
        instance         TEXT NOT NULL,
        chat_jid         TEXT NOT NULL,
        last_incoming_ts INTEGER NOT NULL DEFAULT 0,
        last_read_ts     INTEGER NOT NULL DEFAULT 0,
        updated_at       TEXT NOT NULL,
        PRIMARY KEY (instance, chat_jid)
      );
      CREATE INDEX idx_chat_unread_updated ON chat_unread(updated_at);
    `,
  },
  {
    id: '015-quickreply-media',
    sql: `
      -- Optional media on a quick reply: an image/video/document/audio that goes
      -- out (with the reply text as caption) when an agent picks it. 'media' holds
      -- a lightweight JSON descriptor { kind, mediatype, mimetype, filename?, url? }
      -- that the (polled) list endpoint always returns. 'media_data' holds the
      -- base64 bytes for an uploaded file and is NEVER returned by the list — it is
      -- fetched on demand from /api/quick-replies/:id/media, so the roster stays
      -- small. url-kind media keeps media_data NULL (the bytes live at the URL).
      ALTER TABLE quick_replies ADD COLUMN media TEXT;
      ALTER TABLE quick_replies ADD COLUMN media_data TEXT;
    `,
  },
  {
    id: '016-notify-prefs',
    sql: `
      -- Per-person notification preferences, keyed by the Cloudflare Access
      -- identity (agent_email). '' = anonymous / agent-identification off, which
      -- behaves as a single shared row. Every column defaults so an agent who
      -- never opens the Notifications card keeps today's behavior: group + DM
      -- messages notify, and a job they created pings when it finishes. The
      -- global "channels that notify" list (settings.notify_instances) is a
      -- separate operator-level gate and stays where it is.
      CREATE TABLE notify_prefs (
        agent_email        TEXT PRIMARY KEY,
        groups             INTEGER NOT NULL DEFAULT 1,  -- notify on @g.us messages
        dms                INTEGER NOT NULL DEFAULT 1,  -- notify on direct messages
        jobs_ended         INTEGER NOT NULL DEFAULT 1,  -- push when a job I created finishes
        jobs_failures_only INTEGER NOT NULL DEFAULT 0,  -- only when that job had failures
        quiet_enabled      INTEGER NOT NULL DEFAULT 0,  -- mute window for notifications
        quiet_start        TEXT    NOT NULL DEFAULT '21:00',
        quiet_end          TEXT    NOT NULL DEFAULT '08:00',
        keywords           TEXT    NOT NULL DEFAULT ''  -- comma-separated; a hit pierces mute + quiet hours
      );
    `,
  },
  {
    id: '017-list-recipe',
    sql: `
      -- A "combined" recipient list: its members are the union of other lists
      -- minus the ones it excludes. The MEMBERS ARE MATERIALIZED as ordinary
      -- recipient_list_members rows (so Compose, {{name}} and the blacklist see
      -- a plain list, unchanged), and this column keeps the RECIPE that produced
      -- them so the editor can show it and one click can rebuild it after a
      -- source list changes. NULL = a hand-made list, which is every existing row.
      -- JSON: { v: 1, include: [{ id, name }], exclude: [{ id, name }] } — the
      -- name is a label kept for a source that later gets deleted; the id is the
      -- truth. The math itself lives in frontend/src/lib/listRecipe.ts (the
      -- editor needs it live for the preview count); the server only stores it.
      ALTER TABLE recipient_lists ADD COLUMN recipe TEXT;
    `,
  },
  {
    id: '018-job-batching',
    sql: `
      -- Campaign control for a big blast: how a job is paced into batches, as
      -- JSON { size, pauseMin, pauseAt?, resumeAt? } (see types.ts#BatchRule).
      -- NULL = send in one unbroken run, which is every existing job.
      -- No new state lives here: a batch boundary just puts the job back to
      -- 'pending' (or the new 'paused') with its ledger untouched, so the
      -- resume path is the same one that already survives a crash mid-job.
      ALTER TABLE jobs ADD COLUMN batch TEXT;

      -- The campaign panel reads counts + first/last send straight off the
      -- ledger on every poll; without this a 1000-recipient job would scan
      -- its whole slice of job_sends each time.
      CREATE INDEX IF NOT EXISTS idx_job_sends_sent_at ON job_sends(job_id, sent_at);
    `,
  },
  {
    id: '019-number-verification',
    sql: `
      -- Number verification cache. This is NOT the blacklist, and the split is
      -- deliberate: the blacklist is a POLICY a human authored ("never message
      -- this person"), permanent and defensible. This table is an OBSERVATION
      -- taken from WhatsApp ("this number was/wasn't registered when we asked"),
      -- provisional and occasionally wrong — WhatsApp answers exists:false for
      -- perfectly live numbers while it is rate-limiting us. Keeping them apart
      -- means thousands of machine rows never bury the handful of real opt-outs,
      -- and a bad row here can never be mistaken for a deliberate opt-out.
      --
      -- Both verdicts expire, asymmetrically: being wrong about 'invalid' costs
      -- a real customer for the whole TTL, being wrong about 'valid' costs one
      -- failed send. So the cheap-to-be-wrong verdict is the one allowed to live
      -- longer (defaults: valid 180d, invalid 90d — Settings owns both).
      CREATE TABLE number_verification (
        phone_number TEXT PRIMARY KEY,          -- canonical digits (verifyKey)
        status       TEXT NOT NULL,             -- 'valid' | 'invalid'
        checked_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        instance     TEXT NOT NULL DEFAULT '',  -- which line asked
        jid          TEXT,
        wa_name      TEXT
      );
      -- the send gate reads this per recipient, and the sweep filters out rows
      -- that are still fresh — both want (status, expires_at)
      CREATE INDEX idx_number_verification_expiry
        ON number_verification(status, expires_at);
    `,
  },
  {
    id: '020-cold-contact-cap',
    sql: `
      -- Who a line already has a conversation with. The cold-contact cap rations
      -- FIRST CONTACT only, so it needs to know who is not a stranger — messages
      -- to people you already talk to are not what gets a number banned, and
      -- rationing them would break the tool's day job.
      --
      -- Per instance on purpose: a contact one number speaks to weekly is a
      -- stranger to another number, and the ban risk is per number.
      --
      -- 'inbound' records the strong form of knowing someone (they wrote to us)
      -- as opposed to the bootstrap seed (a thread already existed when the cap
      -- was switched on). Both count as known; only the seed is a grandfather
      -- clause. Us messaging someone never creates a row here — otherwise a cold
      -- list would launder itself one daily allowance at a time.
      CREATE TABLE known_contacts (
        phone_number TEXT    NOT NULL,
        instance     TEXT    NOT NULL DEFAULT '',
        first_seen   TEXT    NOT NULL,
        last_seen    TEXT    NOT NULL,
        inbound      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (phone_number, instance)
      );

      -- One row per cold recipient actually reached, feeding both the rolling
      -- 24h ceiling and the warm-up ramp (distinct earlier days with cold sends).
      -- Rows outside the 30-day ramp window are swept by retention.
      CREATE TABLE cold_sends (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        instance     TEXT NOT NULL DEFAULT '',
        phone_number TEXT NOT NULL,
        sent_at      TEXT NOT NULL
      );
      CREATE INDEX idx_cold_sends_window ON cold_sends(instance, sent_at);
    `,
  },
  {
    id: '021-job-hold-reason',
    sql: `
      -- WHY a campaign stopped short, in the operator's words, kept apart from
      -- 'result'. The result line is a sentence ("… — 60 of 1000 done, continues
      -- …") and the reason itself contains an em dash, so the UI cannot recover
      -- one from the other by splitting. Cleared whenever the job is claimed for
      -- a run or finalized, so a value here always describes a live hold.
      ALTER TABLE jobs ADD COLUMN hold_reason TEXT;
    `,
  },
];
