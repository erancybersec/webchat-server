# Send safety: how this project avoids WhatsApp bans/blocks

Settings UI calls this cluster "Send safety" — *"What keeps this number from being reported and banned. Lower is always safer."*

## 1. Per-message send delay
Random gap (`delayMinMs`–`delayMaxMs`, default 1–3s) waited between real sends, so bulk sending isn't machine-uniform.
- [`backend/src/services/scheduler.ts:620-623`](backend/src/services/scheduler.ts) — `randomDelayMs()`
- [`backend/src/config.ts:14-16,102-104`](backend/src/config.ts) — `DELAY_MIN`/`DELAY_MAX`
- UI: Settings → Sending ([`frontend/src/pages/SettingsPage.tsx:625-652`](frontend/src/pages/SettingsPage.tsx))

## 2. Batching
Batch size + pause between batches, with an optional randomized pause *range*.
- [`backend/src/services/scheduler.ts:259-268,456-470`](backend/src/services/scheduler.ts) — batch boundary + wire-attempt counting
- A multi-item sequence to one recipient is never split across a batch boundary — nobody's left mid-conversation overnight.

## 3. Daily sending-hours window ("quiet hours")
Default 21:00–08:00. An immediate "send now" job bypasses quiet hours only on its *first* run — a batch still running hours later no longer counts as "someone at the keyboard."
- [`backend/src/services/time.ts:16-31`](backend/src/services/time.ts) — `inQuietHours`, `nextClockTime`
- [`backend/src/config.ts:63-66`](backend/src/config.ts) — `quietEnabled`/`quietStart`/`quietEnd`
- [`backend/src/services/scheduler.ts:209-222`](backend/src/services/scheduler.ts)

## 4. Cold-contact daily cap with warm-up ramp
The core anti-ban mechanism. Recipients are classified `group`/`known`/`cold` and first-contact volume is capped per day, ramping exponentially from `coldWarmupStart` (10) toward `coldDailyCap` (50) over `coldRampWindowDays` (30 days).

> *"A number with no bulk history that suddenly reaches hundreds of strangers is the exact anomaly WhatsApp acts on."*

- [`backend/src/services/quota.ts`](backend/src/services/quota.ts) — `ColdSendQuota`, `capFor()`, `activeDays()`
- [`backend/src/services/familiarity.ts:77-82`](backend/src/services/familiarity.ts) — `classify()`; seeded from existing Evolution chats at boot so history isn't misread as cold
- [`backend/src/config.ts:53-58,123-126`](backend/src/config.ts) — defaults
- Per-compose override: a flat cap for one job, [`backend/src/routes/jobs.ts:111-118`](backend/src/routes/jobs.ts)

## 5. Randomization / jitter
- Message delay and batch pause are randomized ranges (see #1, #2), not fixed numbers.
- The separate number-verification sweep (checking if a number is on WhatsApp) adds `PAUSE_JITTER`/`SIZE_JITTER` and a 1-in-8 chance of a long "coffee break" pause:
  > *"a drip that asks about exactly 10 numbers every 60s is a metronome, and a metronome is the easiest thing to spot in a request log"*
- [`backend/src/services/verification.ts:37-66`](backend/src/services/verification.ts)

## 6. Typing indicator / presence simulation
**Not implemented.** No `composing`/`presence.update` call is sent to Evolution before a message send.

## 7. Message content randomization (spintax)
**Not implemented.** Only `{{name}}`-style placeholder personalization exists ([`backend/src/services/personalize.ts`](backend/src/services/personalize.ts)) — no synonym/text rotation to make bulk messages textually distinct.

## 8. Blacklist & auto opt-out
- Hard block at the single send choke point: [`backend/src/services/sender.ts:52-56`](backend/src/services/sender.ts)
- Optional keyword-triggered opt-out (default `STOP, הסר`) auto-blacklists a replier: [`backend/src/services/optout.ts`](backend/src/services/optout.ts)

## 9. Retry / error-code handling
- "Not on WhatsApp" numbers are recorded and never retried ([`sender.ts:65-73`](backend/src/services/sender.ts), [`verification.ts:89-100`](backend/src/services/verification.ts))
- Retryable failures cap at `sendMaxAttempts` (default 3)
- A "throttle breaker" discards a verification batch if 25 consecutive numbers come back invalid — treated as suspected rate-limiting, not real data ([`verification.ts:308-431`](backend/src/services/verification.ts))
- A connection-health check pauses the job if the WhatsApp session itself drops, instead of burning attempts against a dead line ([`scheduler.ts:57-60,368-384`](backend/src/services/scheduler.ts))

## 10. Multi-instance / number rotation
**Not implemented.** Each job is pinned to one instance — no load-balancing or rotation across numbers.

## Representative comments in the code
- `verification.ts:38-51` — pacing "chosen to look unremarkable" against rate-limit detection
- `verification.ts:86-92` / `ARCHITECTURE.md:86-90` — "1,045 existence lookups inside 40 seconds is indistinguishable from contact scraping"
- `familiarity.ts:12-15` — cold = "the risky class: an unsolicited first message is what recipients report, and reports are what get a number banned"
- `config.ts:33-35` — verify batching "paced for a BACKGROUND drip, not a pre-flight burst... the signature of contact scraping"
