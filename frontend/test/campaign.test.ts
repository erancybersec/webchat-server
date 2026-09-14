import { describe, expect, it } from 'vitest';
import {
  activeDaysLabel,
  batchSummary,
  canContinueNow,
  coldCapCaveat,
  estimateFinish,
  holdInfo,
  humanMinutes,
  isCampaign,
  isOngoingForChat,
  paceSummary,
  progressLine,
} from '../src/lib/campaign';
import type { CampaignProgress } from '../src/types';

const progress = (over: Partial<CampaignProgress> = {}): CampaignProgress => ({
  jobId: 'j1',
  status: 'running',
  total: 1043,
  sent: 300,
  skipped: 10,
  failed: 2,
  pending: 731,
  startedAt: new Date().toISOString(),
  firstSentAt: new Date().toISOString(),
  lastSentAt: new Date().toISOString(),
  ratePerMin: 18.4,
  etaMinutes: 40,
  batch: null,
  nextRunAt: null,
  holdReason: null,
  contacts: { sent: 300, skipped: 10, failed: 2, pending: 731 },
  batchSent: null,
  ...over,
});

/** Matches `holdInfo`'s own "today at HH:MM" wording for a same-day resume —
 *  every fixture below schedules `nextRunAt` 30 minutes out, so it never
 *  crosses into "tomorrow". */
const todayAt = (iso: string) =>
  `today at ${new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

describe('durations', () => {
  it('reads like a person wrote it', () => {
    expect(humanMinutes(0.4)).toBe('under a minute');
    expect(humanMinutes(12)).toBe('12m');
    expect(humanMinutes(60)).toBe('1h');
    expect(humanMinutes(200)).toBe('3h 20m');
    expect(humanMinutes(1500)).toBe('1d 1h');
  });
});

describe('progress line', () => {
  it('spells out sent, skipped, failed and remaining as one plain line', () => {
    expect(progressLine(progress())).toBe(
      '300 of 1,043 sent · 10 skipped · 2 failed · 731 remaining · 18/min, about 40m left',
    );
  });

  it('drops skipped/failed/remaining clauses that are zero, and the pace with them', () => {
    expect(progressLine(progress({ pending: 0, sent: 1043, skipped: 0, failed: 0 }))).toBe('1,043 of 1,043 sent');
  });

  it('promises no finish time for a campaign that is waiting for a human', () => {
    // a paused campaign continues when someone says so — not at some pace
    expect(progressLine(progress({ status: 'paused' }))).toBe('300 of 1,043 sent · 10 skipped · 2 failed · 731 remaining');
    expect(progressLine(progress({ status: 'cancelled' }))).toBe(
      '300 of 1,043 sent · 10 skipped · 2 failed · 731 remaining',
    );
  });

  it('reads "under a minute left" rather than "about under a minute"', () => {
    expect(progressLine(progress({ etaMinutes: 0.3 }))).toContain('under a minute left');
    expect(progressLine(progress({ etaMinutes: 0.3 }))).not.toContain('about under');
  });

  it('keeps one decimal on a slow campaign', () => {
    expect(progressLine(progress({ ratePerMin: 1.5, etaMinutes: null }))).toContain('1.5/min');
  });

  it('drops the pace when an attention hold is active — it would contradict the hold block', () => {
    // the server's rate/ETA math has no idea the daily cap is about to hold
    // this for hours; showing "under a minute left" next to a block that
    // says "resumes tomorrow" would be a visible, confusing contradiction
    const capped = progress({
      status: 'pending',
      holdReason: 'daily cold-contact cap reached — 20 first-time recipients held back',
    });
    expect(progressLine(capped)).not.toContain('/min');
    expect(progressLine(capped)).not.toContain('left');
    expect(progressLine(capped)).toBe('300 of 1,043 sent · 10 skipped · 2 failed · 731 remaining');
    // a routine hold (batch/window/day) keeps the pace — it's still honest
    expect(progressLine(progress({ status: 'pending', holdReason: 'batch of 50 sent' }))).toContain('/min');
  });
});

describe('holdInfo — the one thing to say about why a campaign is not sending', () => {
  it('never leaks scheduler vocabulary — every routine scenario gets its own plain sentence', () => {
    const next = new Date(Date.now() + 30 * 60_000).toISOString();
    const when = todayAt(next);

    // sending window closed, auto-resumes — the wording must say "sending
    // hours", never repeat the raw "reached 21:00" the server sent
    const window = holdInfo(
      progress({ status: 'pending', nextRunAt: next, batch: { size: 30, pauseMin: 5 }, holdReason: 'reached 21:00' }),
    );
    expect(window).toEqual({ headline: 'Outside sending hours', detail: `Sending resumes ${when}`, kind: 'routine' });

    // not one of the campaign's active days
    const day = holdInfo(
      progress({
        status: 'pending',
        nextRunAt: next,
        batch: { size: 30, pauseMin: 5 },
        holdReason: 'not an active day for this campaign',
      }),
    );
    expect(day).toEqual({ headline: 'Not an active day', detail: `Sending resumes ${when}`, kind: 'routine' });

    // a plain batch boundary is routine and resolves itself within minutes,
    // but it still gets a block — a "Waiting" pill with nothing under it
    // reads as broken, not calm
    const batch = holdInfo(
      progress({ status: 'pending', nextRunAt: next, batch: { size: 30, pauseMin: 5 }, holdReason: 'batch of 30 sent' }),
    );
    expect(batch).toEqual({ headline: 'Between batches', detail: `Next batch ${when}`, kind: 'routine' });
  });

  it('tells a sending-window wait apart from a batch wait even when both are configured on the same job', () => {
    // this is exactly the confusing case: a campaign with BOTH a batch size
    // and a sending window hits the window boundary, not a batch boundary —
    // the block must say so, not default to "batch" just because a batch
    // size happens to be set too (that was a real mislabel).
    const next = new Date(Date.now() + 30 * 60_000).toISOString();
    const bothConfigured = { size: 30, pauseMin: 5 } as const;
    expect(
      holdInfo(progress({ status: 'pending', nextRunAt: next, batch: bothConfigured, holdReason: 'reached 21:00' }))
        ?.headline,
    ).toBe('Outside sending hours');
    expect(
      holdInfo(progress({ status: 'pending', nextRunAt: next, batch: bothConfigured, holdReason: 'batch of 30 sent' }))
        ?.headline,
    ).toBe('Between batches');
  });

  it('flags the daily cold-contact cap as needing attention, with the count in plain words', () => {
    const next = new Date(Date.now() + 30 * 60_000).toISOString();
    const when = todayAt(next);
    const cap = holdInfo(
      progress({
        status: 'pending',
        nextRunAt: next,
        batch: { size: 50, pauseMin: 30 },
        holdReason: 'daily cold-contact cap reached — 12 first-time recipients held back',
      }),
    );
    expect(cap).toEqual({
      headline: 'Daily contact limit reached',
      detail: `12 new contacts held back — resumes ${when}`,
      kind: 'attention',
    });
    // no count in the reason string — still says something sensible
    expect(
      holdInfo(progress({ status: 'pending', nextRunAt: next, holdReason: 'daily cold-contact cap reached' }))?.detail,
    ).toBe(`Resumes ${when}`);
  });

  it('reads a manual pause, a window pause with nowhere to auto-resume, and an unrecognized hold differently', () => {
    // a plain hand pause explains itself — no reason to repeat
    expect(holdInfo(progress({ status: 'paused' }))).toEqual({
      headline: 'Paused',
      detail: "Won't resume until you press Continue",
      kind: 'routine',
    });
    // the window closed with no resumeAt configured — this landed on 'paused'
    // (nothing to schedule), and still deserves the accurate cause, not a
    // generic "Paused" that reads as if a human pressed the button
    expect(holdInfo(progress({ status: 'paused', holdReason: 'reached 21:00' }))).toEqual({
      headline: 'Outside sending hours',
      detail: "Won't resume until you press Continue",
      kind: 'routine',
    });
    // an unrecognized reason (a dead WhatsApp line, say) still gets flagged
    expect(holdInfo(progress({ status: 'paused', holdReason: 'the WhatsApp line is disconnected' }))).toEqual({
      headline: 'Needs attention',
      detail: "the WhatsApp line is disconnected — won't resume until you press Continue",
      kind: 'attention',
    });
  });

  it('says Stopped for a cancelled campaign with unsent rows', () => {
    expect(holdInfo(progress({ status: 'cancelled' }))).toEqual({
      headline: 'Stopped',
      detail: '731 never sent',
      kind: 'routine',
    });
  });

  it('says nothing while it is simply running, once it is finished, or once an old hold is in the past', () => {
    expect(holdInfo(progress())).toBeNull();
    expect(holdInfo(progress({ status: 'done', pending: 0 }))).toBeNull();
    // a batch/window pause already in the past is not something to announce
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(holdInfo(progress({ status: 'pending', nextRunAt: past }))).toBeNull();
  });
});

describe('canContinueNow', () => {
  it('is true for every hold "Continue now" can actually shortcut', () => {
    expect(canContinueNow(null)).toBe(true);
    expect(canContinueNow('batch of 50 sent')).toBe(true);
    expect(canContinueNow('reached 21:00')).toBe(true);
    expect(canContinueNow('not an active day for this campaign')).toBe(true);
    expect(canContinueNow('the WhatsApp line is disconnected')).toBe(true);
  });

  it('is false only for the daily cold-contact cap — it re-hits the same limit immediately', () => {
    expect(canContinueNow('daily cold-contact cap reached — 12 first-time recipients held back')).toBe(false);
  });
});

describe('paceSummary', () => {
  it('is null with no pacing rule at all', () => {
    expect(paceSummary(null)).toBeNull();
    expect(paceSummary({ pauseMin: 0 })).toBeNull();
  });

  it('reads the sending-hours window as a plain range', () => {
    expect(paceSummary({ pauseMin: 0, pauseAt: '21:00', resumeAt: '09:00' })).toBe('Sending hours 09:00–21:00');
  });

  it('says so when the window has no auto-resume', () => {
    expect(paceSummary({ pauseMin: 0, pauseAt: '21:00' })).toBe('Sends until 21:00');
  });

  it('describes batch pacing without the within-batch counter', () => {
    expect(paceSummary({ size: 30, pauseMin: 5 })).toBe('batches of 30, 5m apart');
    expect(paceSummary({ size: 30, pauseMin: 0 })).toBe('batches of 30 — manual continue');
  });

  it('combines hours, active days and batching into one sentence', () => {
    expect(
      paceSummary({ pauseAt: '21:00', resumeAt: '09:00', pauseMin: 5, activeDays: [1, 3, 5], size: 30 }),
    ).toBe('Sending hours 09:00–21:00 · on Mon, Wed, Fri · batches of 30, 5m apart');
  });
});

describe('pacing read-back in Compose', () => {
  // fixed well clear of any pauseAt used below, so a run that comfortably
  // finishes today never accidentally crosses into a day-boundary case
  const NOW = new Date(2026, 7, 23, 10, 0, 0);

  it('describes a sending window on its own — the common case, no batching', () => {
    expect(batchSummary({ pauseMin: 0, pauseAt: '21:00', resumeAt: '09:00' }, 1000, 2, NOW)).toBe(
      '1,000 messages — sends until 21:00, then continues at 09:00 · about 33m of sending',
    );
  });

  it('has no window or batch clause when only an advanced override is on', () => {
    expect(batchSummary({ pauseMin: 0, delay: { minSec: 5, maxSec: 10 } }, 1000, 7.5, NOW)).toBe(
      '1,000 messages — about 2h 5m of sending',
    );
  });

  it('says a window with no continue-time waits for a human', () => {
    expect(batchSummary({ pauseMin: 0, pauseAt: '21:00' }, 1000, 2, NOW)).toContain(
      'waits for your Continue',
    );
  });

  it('spells out batches and what they will cost in time', () => {
    expect(batchSummary({ size: 50, pauseMin: 30 }, 1000, 2, NOW)).toBe(
      '1,000 messages in 20 batches of up to 50, 30m apart — about 10h 3m in total',
    );
  });

  it('is explicit when every batch waits for a human', () => {
    expect(batchSummary({ size: 50, pauseMin: 0 }, 1000, 2, NOW)).toContain(
      'each waits for your Continue',
    );
  });

  it('reads both halves when a campaign batches inside a window', () => {
    const both = batchSummary(
      { size: 50, pauseMin: 15, pauseAt: '21:00', resumeAt: '09:00' },
      1000,
      2,
      NOW,
    );
    expect(both).toContain('20 batches of up to 50');
    expect(both).toContain('sends until 21:00, then continues at 09:00');
  });

  it('says so when the batch is bigger than the send', () => {
    expect(batchSummary({ size: 500, pauseMin: 30 }, 100, 2, NOW)).toContain('no batch pause');
  });

  it('counts the overnight gap in the total instead of silently understating it', () => {
    // starting 30 minutes before the cutoff, ~10h of batching cannot possibly
    // fit before 21:00 — it must cross and pick back up at 09:00 the next day.
    // The Compose UI renders the actual finish moment separately (bold) via
    // estimateFinish — batchSummary's job here is just an honest total.
    const closeToCutoff = new Date(2026, 7, 23, 20, 30, 0);
    const summary = batchSummary(
      { size: 50, pauseMin: 30, pauseAt: '21:00', resumeAt: '09:00' },
      1000,
      2,
      closeToCutoff,
    );
    // the naive (buggy) additive total would be under 10h — the honest one
    // must be noticeably larger once the overnight gap is counted
    expect(summary).not.toContain('about 10h');
  });

  it('shows a ranged batch wait as "min–max apart"', () => {
    expect(batchSummary({ size: 50, pauseMin: 20, pauseMinMax: 40 }, 1000, 2, NOW)).toContain(
      '20–40m apart',
    );
  });

  it('names the active days on their own when there is no hour window', () => {
    expect(batchSummary({ pauseMin: 0, activeDays: [0, 3] }, 100, 2, NOW)).toContain('on Sun, Wed');
  });

  it('names the active days alongside the hour window when both are set', () => {
    const summary = batchSummary(
      { pauseMin: 0, pauseAt: '21:00', resumeAt: '09:00', activeDays: [1, 3, 5] },
      1000,
      2,
      NOW,
    );
    expect(summary).toContain('sends until 21:00, then continues at 09:00, on Mon, Wed, Fri');
  });
});

describe('estimateFinish', () => {
  const NOW = new Date(2026, 7, 23, 10, 0, 0);

  it('matches the naive formula when there is no window', () => {
    const est = estimateFinish({ size: 50, pauseMin: 30 }, 1000, 2, NOW);
    expect(est).not.toBeNull();
    expect(est!.totalMinutes).toBeCloseTo((1000 * 2) / 60 + 19 * 30, 5);
  });

  it('gives no estimate past a manual batch wait', () => {
    expect(estimateFinish({ size: 50, pauseMin: 0 }, 1000, 2, NOW)).toBeNull();
  });

  it('gives no estimate past a window with no auto-resume', () => {
    expect(estimateFinish({ pauseMin: 0, pauseAt: '21:00' }, 1000, 2, NOW)).toBeNull();
  });

  it('counts the overnight gap instead of running straight through the cutoff', () => {
    // 30 minutes from the cutoff, ~10h of batching cannot fit before it
    const closeToCutoff = new Date(2026, 7, 23, 20, 30, 0);
    const est = estimateFinish(
      { size: 50, pauseMin: 30, pauseAt: '21:00', resumeAt: '09:00' },
      1000,
      2,
      closeToCutoff,
    );
    expect(est).not.toBeNull();
    // starting just before 21:00, the run must cross it and land the next day
    expect(est!.finishAt.getDate()).toBe(closeToCutoff.getDate() + 1);
    expect(est!.finishAt.getHours()).toBeGreaterThanOrEqual(9);
  });

  it('estimates a ranged batch wait at its midpoint', () => {
    const ranged = estimateFinish({ size: 50, pauseMin: 20, pauseMinMax: 40 }, 1000, 2, NOW);
    const midpoint = estimateFinish({ size: 50, pauseMin: 30 }, 1000, 2, NOW);
    expect(ranged!.totalMinutes).toBeCloseTo(midpoint!.totalMinutes, 5);
  });

  it('a day gate alone (no hour window) still paces a big send, one day at a time', () => {
    const otherDay = (NOW.getDay() + 2) % 7;
    const est = estimateFinish({ pauseMin: 0, activeDays: [otherDay] }, 5, 2, NOW);
    expect(est).not.toBeNull();
    expect(est!.finishAt.getDay()).toBe(otherDay);
  });

  it("a per-day override, not the rule's own hours, decides today's cutoff", () => {
    const today = NOW.getDay();
    const est = estimateFinish(
      {
        pauseMin: 0,
        pauseAt: '23:00', // ignored today — the override below wins
        resumeAt: '09:00',
        activeDays: [today],
        dayHours: { [today]: { pauseAt: '10:00', resumeAt: '10:30' } },
      },
      1000,
      2,
      NOW, // NOW is 10:00 — right at the override's cutoff
    );
    expect(est).not.toBeNull();
    // must roll into the override's resumeAt, not the rule's own 09:00/23:00
    expect(est!.finishAt.getTime()).toBeGreaterThanOrEqual(
      new Date(2026, 7, 23, 10, 30, 0).getTime(),
    );
  });
});

describe('activeDaysLabel', () => {
  it('lists days in calendar order regardless of input order', () => {
    expect(activeDaysLabel([4, 0, 2])).toBe('Sun, Tue, Thu');
  });
});

describe('coldCapCaveat', () => {
  const limit = (over: Partial<{ spent: number; cap: number; remaining: number | null; enabled: boolean }> = {}) => ({
    spent: 0,
    cap: 50,
    remaining: 50,
    enabled: true,
    ...over,
  });

  it('says nothing when the list fits inside today\'s ration', () => {
    expect(coldCapCaveat(30, limit({ remaining: 50 }))).toBeNull();
  });

  it('says nothing when capping is off and there is no override', () => {
    expect(coldCapCaveat(999, limit({ enabled: false, remaining: null }))).toBeNull();
  });

  it('gives an exact day count, worst-case, when the list exceeds the ration', () => {
    // 120 recipients, 50 left today, cap 50/day thereafter → 1 + ceil(70/50) = 3
    expect(coldCapCaveat(120, limit({ remaining: 50, cap: 50 }))).toBe(
      'If every recipient turns out to be new, the cap alone would take about 3 days — depends how many are already known.',
    );
  });

  it('uses the override instead of the fetched ration when one is set', () => {
    // override raises the cap well above the list size — no caveat needed
    expect(coldCapCaveat(120, limit({ remaining: 10, cap: 10, spent: 5 }), { dailyCap: 200 })).toBeNull();
    // override lower than the fetched ration — the caveat reacts to it, not the fetch
    expect(coldCapCaveat(30, limit({ remaining: 50, cap: 50 }), { dailyCap: 10 })).toContain('day');
  });
});

describe('which jobs get the campaign panel', () => {
  it('is any paced, started, or simply big send', () => {
    const job = { recipients: [{ id: '1' }], batch: null, startedAt: null };
    expect(isCampaign(job)).toBe(false);
    expect(isCampaign({ ...job, batch: { size: 10, pauseMin: 0 } })).toBe(true);
    expect(isCampaign({ ...job, batch: { pauseMin: 0, pauseAt: '21:00' } })).toBe(true);
    expect(isCampaign({ ...job, startedAt: new Date().toISOString() })).toBe(true);
    expect(isCampaign({ ...job, recipients: Array.from({ length: 20 }, (_, i) => ({ id: `${i}` })) })).toBe(true);
  });
});

describe('which jobs still count as "ongoing" from one contact\'s chat', () => {
  const oneRecipient = [{ id: '1' }];
  const twoRecipients = [{ id: '1' }, { id: '2' }];

  it('a plain scheduled job counts while pending or paused, not once finished', () => {
    expect(isOngoingForChat({ status: 'pending', type: 'compose', recipients: oneRecipient })).toBe(true);
    expect(isOngoingForChat({ status: 'paused', type: 'compose', recipients: oneRecipient })).toBe(true);
    expect(isOngoingForChat({ status: 'done', type: 'compose', recipients: oneRecipient })).toBe(false);
    expect(isOngoingForChat({ status: 'cancelled', type: 'compose', recipients: oneRecipient })).toBe(false);
  });

  it('a single-recipient "send now" is too quick to be worth surfacing', () => {
    expect(isOngoingForChat({ status: 'pending', type: 'immediate', recipients: oneRecipient })).toBe(false);
  });

  it('a multi-recipient "send now" campaign still counts while it paces itself', () => {
    expect(isOngoingForChat({ status: 'pending', type: 'immediate', recipients: twoRecipients })).toBe(true);
    expect(isOngoingForChat({ status: 'paused', type: 'immediate', recipients: twoRecipients })).toBe(true);
    expect(isOngoingForChat({ status: 'done', type: 'immediate', recipients: twoRecipients })).toBe(false);
  });
});
