# Lessons

- **Never edit JSON files with PowerShell 5.1 `Set-Content -Encoding utf8`** — it
  writes a BOM, and tsx's package.json reader chokes on it (`Error parsing:
  backend\package.json`). Use the Edit tool, or
  `[IO.File]::WriteAllText(path, text, UTF8Encoding($false))`. (2026-06-12,
  hit during the v2.4 version bump.)
- **Check running previews before editing backend code.** The `backend` preview
  (port 8080) talks to the real WhatsApp account and restarts on file edits —
  stop it first; verify against `backend-sandbox` (8090) instead, and delete
  `data/sandbox-verify.db` afterwards.
- **Scheduler tests hook `jobs.allSends`** — runJob calls it once at the start
  (progress seeding) and once at finalize; mocks that simulate finalize-gap
  races must skip the first call.
- **PS5.1 mangles embedded double quotes in `git commit -m @'…'@`** — the
  here-string survives PowerShell but the native-arg pass to git splits on the
  inner quotes. Write the message to a file and `git commit -F` it.
  (2026-06-13, v2.8 frontend commit.)
- **`data/sandbox-verify.db` can be a leftover** from a previous QA run (it
  survived the v2.7 session). Don't assume a fresh bootstrap — either delete
  it before starting or use identities that already exist in it. Upside: a
  leftover DB exercises the migration upgrade path for free.
- **Evolution's GLOBAL websocket wraps every payload in `{instance, data}`**
  — backend listeners that pattern-match record fields on `e.data` directly
  silently no-op in production while passing every test that feeds bare
  records. v2.4–v2.8 shipped acks/opt-out/alias-learning/auto-reopen dead
  this way. Always go through `services/envelope.ts#unwrapEvent`, and give
  new listeners an envelope-shaped test (see test/envelope.test.ts).
  (2026-06-13, found during the v2.9 QA sweep.)
- **Migration rehearsal against prod data is cheap**: better-sqlite3
  `db.backup()` inside the container → `pscp` the copy → `openDb()` it
  locally. Proved 006→007 on the live 196KB DB before deploying v2.9.
