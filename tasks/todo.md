# v2.10 — QA + UI improvements (2026-06-13, autonomous 5–7h)

User brief: perform QA, fix bugs, improve UI. Specific asks below.
Baseline: 217 backend + 14 frontend tests green, typecheck clean (v2.9.1).

## Plan (branch `feat/v2.10-qa-ui`)

### A. Permissions — agents can't clear history (bug/safety)
- [ ] New permission key `jobs.clearHistory` (admin default).
- [ ] Guard `POST /api/jobs/clear-done` with it.
- [ ] Frontend: hide the Clear button when denied; add to GRANTABLE perms.
- [ ] Test: route 403 for a plain agent, 200 for admin.

### B. Terminology — "line" → "channel"
- [ ] Rename user-facing "line"/"WhatsApp line" → "channel". Frontend-only.

### C. Tab order — Insights immediately left of Settings
- [ ] Tail order: …blacklist, profile, insights, settings.

### D. Reactions — WhatsApp semantics (bug)
- [ ] Per-sender dedup: keep each sender's latest; empty reaction = removal.
- [ ] chatModel: keep empty-text reactions so removals supersede; keep
      senderJid + timestamp + pushName on reactions.
- [ ] MessageBubble: aggregate per emoji from deduped set; tooltip lists who
      reacted with what and when.
- [ ] frontend/test for the dedup/removal logic.

### E. Insights — custom dates + chat size on disk + UI polish
- [ ] Analytics: accept explicit `from`/`to` range alongside `days`.
- [ ] Frontend: custom date-range picker.
- [ ] Chat storage size estimate (count × avg-bytes/msg, labelled estimate)
      next to the "x msgs" line in the server-health card.

### F. Mobile UI — top bar overloaded, channel switcher too wide
- [ ] Compact the mobile channel switcher.
- [ ] Tighten the top tab row.

### G. Read receipts — honest UI, no false "unread"
- [ ] Ticks tooltip explains sent/delivered/read; warns some recipients
      disable read receipts so "delivered" ≠ "unread".

## Verification
- [x] backend + frontend tests + typecheck + build all green
      (219 backend, +2; 18 frontend, +4). Production build OK.
- [x] Headless sandbox QA (backend-sandbox 8090 w/ unreachable Evolution, no
      live account contact): tab order = …Blacklist, Profile, Insights,
      Settings ✓; Insights renders with 7/30/90 + Custom date picker (From/To
      capped at today + Apply) ✓; backend echoes from/to and computes inclusive
      windows ✓; mobile (390px) tab strip scrolls with real tap targets, theme
      pinned ✓; "Default channel" rename present, old "(line)" gone ✓; no
      console errors. Sandbox DB removed afterwards.

## Review — done (all 8 brief items)
- A. clear-history: new `jobs.clearHistory` perm (admin default), guards
  `POST /api/jobs/clear-done`; button hidden + added to Settings roster.
- B. "line" → "channel" across the UI.
- C. Insights tab moved to sit immediately left of Settings.
- D. reactions: pure `collapseReactions` (one per sender, latest wins, empty =
  removed) + who/when tooltip. Regression tests added.
- E. Insights: custom from/to range (threaded through summary/agents/CSV);
  per-channel estimated chat-message disk size next to the msg count.
- F. mobile: scrollable tab strip + capped channel switcher + pinned theme.
- G. read receipts: honest tick tooltip (delivered ≠ unread; receipts may be
  off).

Not done / deferred:
- Not deployed — code only. Version bumped to 2.10.0; deploy + deploy/README
  entry to follow when the user ships.
- Reaction/read-receipt tooltips proven by unit tests + JSX review (need live
  chat data to see rendered; sandbox has none).
- Chat-message disk size is an estimate (~1.7 KB/msg from prod) — the webchat
  backend can't read Evolution's Postgres table sizes directly.
</content>
