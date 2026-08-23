# Local dev/test rig

A localhost copy of the app to click through a new version **before** deploying it to the
studio server. You run as **admin eran**, with the **same users (agents)** as prod, against
the **real (prod) Evolution**.

> ⚠️ **Evolution is fully live** — the same WhatsApp line as prod. Reads/chats are safe, but
> any **send** (compose, a chat reply, or a job you schedule here) goes to a **real** number.
> Automation (recurring / opt-out) is kept OFF in `.env.dev` so dev can't auto-send.

Isolation: dev uses its own `data/dev.db`; prod and the `preview.db` sandbox are untouched.

## One-time setup

Seed the dev DB with the prod users. This pulls a read-only copy of the prod DB (prod is not
modified) — host creds are kept outside this repo.

```powershell
# 1. Pull the prod DB next to the seed input (host/creds/hostkey are yours to fill in)
pscp -batch -pw <password> -hostkey "<host-key-fingerprint>" `
  <user>@<host>:/home/eran/webchat-v2/data/webchat.db ./data/prod-webchat.db
# (also copy webchat.db-wal / -shm if present, so recent rows fold in)

# 2. Create data/dev.db (runs migrations) and copy the agents in — idempotent
npm run seed:dev

# 3. Remove the temp copy
Remove-Item ./data/prod-webchat.db*
```

You can re-run step 1–2 anytime to refresh the roster. (Even with no seeding, the first
identity seen on an empty `dev.db` becomes admin, so eran-as-admin always works.)

## Run it (every time you want to test)

With the new version checked out, in **two terminals**:

```powershell
npm run dev:local:api    # backend on :8080, data/dev.db, prod Evolution (live)
npm run dev:local:web    # vite on :5173, injects eran's identity on /api
```

Open <http://localhost:5173> → you're signed in as eran (admin); Settings/Insights unlocked.

## Verifying a campaign without messaging anyone

Pausing, continuing and pacing need a job that actually *runs* for a while — but
every send from the dev rig goes to a real number. So there is a third mode: a
**mock Evolution** that accepts sends and answers the read endpoints, on
`127.0.0.1:9099`.

```powershell
node scripts/mock-evolution.mjs          # accepts /message/send*, logs each one
```

Then start the `backend-sandbox-mockevo` launch config (port 8090, its own
`data/sandbox-verify.db`, `SEND_MAX_ATTEMPTS=2`, 1–2s pacing) with
`frontend-sandbox`, and compose a big send at it. Sends "succeed" with a
plausible `key.id`, so the ledger fills with real `sent` rows, the campaign card
shows live progress, and Pause / Continue / Edit-remaining behave exactly as in
production. Nothing leaves the machine. Delete the sandbox DB afterwards.

For a **sending window** ("pause at 21:00, continue at 09:00") set the two times
a minute or two ahead instead of waiting for the evening — the cutoff is fixed
from the clock when each run starts, so a two-minute window exercises the same
code path.

## Knobs

- **Run as a different user / no identity:** edit `VITE_DEV_AS_EMAIL` in `frontend/.env.local`
  (comment it out for the unrestricted "no identity" path).
- **Backend config:** `.env.dev` (DB path, Evolution creds, automation toggles).

## Files

| File | Role |
| --- | --- |
| `.env.dev` | dev backend config (git-ignored) |
| `frontend/.env.local` | injected dev identity (git-ignored) |
| `scripts/seed-dev-agents.ts` | copies the prod `agents` table into `data/dev.db` |
| `scripts/mock-evolution.mjs` | fake Evolution on `:9099` — accepts sends so campaigns can be driven end-to-end without messaging anyone |
| `frontend/vite.config.ts` | injects the Access header when `VITE_DEV_AS_EMAIL` is set |
