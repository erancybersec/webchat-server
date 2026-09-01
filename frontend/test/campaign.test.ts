import { describe, expect, it } from 'vitest';
import {
  batchSummary,
  clockLabel,
  coldCapCaveat,
  estimateFinish,
  humanMinutes,
  isCampaign,
  progressLine,
  waitingLabel,
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
  ...over,
});

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
  it('counts everything processed, not just the successes', () => {
    expect(progressLine(progress())).toBe('312 of 1,043 · 18/min · about 40m left');
  });

  it('drops the pace and the estimate once nothing is left', () => {
    expect(progressLine(progress({ pending: 0, sent: 1031 }))).toBe('1,043 of 1,043');
  });

  it('promises no finish time for a campaign that is waiting for a human', () => {
    // a paused campaign continues when someone says so — not at some pace
    expect(progressLine(progress({ status: 'paused' }))).toBe('312 of 1,043');
    expect(progressLine(progress({ status: 'cancelled' }))).toBe('312 of 1,043');
  });

  it('reads "under a minute left" rather than "about under a minute"', () => {
    expect(progressLine(progress({ etaMinutes: 0.3 }))).toContain('under a minute left');
    expect(progressLine(progress({ etaMinutes: 0.3 }))).not.toContain('about under');
  });

  it('keeps one decimal on a slow campaign', () => {
    expect(progressLine(progress({ ratePerMin: 1.5, etaMinutes: null }))).toContain('1.5/min');
  });
});

describe('what it is waiting for', () => {
  it('names the hold, and the moment an unattended pause ends', () => {
    expect(waitingLabel(progress({ status: 'paused' }))?.text).toBe('Paused · 731 still to send');
    expect(waitingLabel(progress({ status: 'cancelled' }))?.text).toBe('Stopped · 731 never sent');
    const next = new Date(Date.now() + 30 * 60_000).toISOString();
    // with batches it is the next batch; with only a sending window it just continues
    expect(
      waitingLabel(progress({ status: 'pending', nextRunAt: next, batch: { size: 50, pauseMin: 30 } }))?.text,
    ).toMatch(/^Next batch /);
    expect(
      waitingLabel(progress({ status: 'pending', nextRunAt: next, batch: { pauseMin: 0, pauseAt: '21:00', resumeAt: '09:00' } }))?.text,
    ).toMatch(/^Continues /);
  });

  it('says WHY it stopped when the server gave a reason the operator needs to act on', () => {
    const next = new Date(Date.now() + 30 * 60_000).toISOString();
    const why = 'daily cold-contact cap reached — 940 first-time recipients held back';
    // a cap hold and a plain batch boundary both "continue at 09:00" — only the
    // reason (and the 'attention' kind) tells the operator which of them needs
    // them to do something
    const capHold = waitingLabel(
      progress({ status: 'pending', nextRunAt: next, batch: { size: 50, pauseMin: 30 }, holdReason: why }),
    );
    expect(capHold?.text).toBe(`Continues ${clockLabel(next)} — ${why}`);
    expect(capHold?.kind).toBe('attention');
    const deadLine = waitingLabel(progress({ status: 'paused', holdReason: 'the WhatsApp line is disconnected' }));
    expect(deadLine?.text).toBe('Paused — the WhatsApp line is disconnected · 731 still to send');
    expect(deadLine?.kind).toBe('attention');
    // a routine batch boundary (or the sending window closing) is already
    // explained by the pacing chips next to it — no reason repeated, and it's
    // not flagged as something to look at
    const batchHold = waitingLabel(
      progress({ status: 'pending', nextRunAt: next, batch: { size: 50, pauseMin: 30 }, holdReason: 'batch of 50 sent' }),
    );
    expect(batchHold?.text).toBe(`Next batch ${clockLabel(next)}`);
    expect(batchHold?.kind).toBe('routine');
    const windowHold = waitingLabel(progress({ status: 'paused', holdReason: 'reached 21:00' }));
    expect(windowHold?.text).toBe('Paused · 731 still to send');
    expect(windowHold?.kind).toBe('routine');
    // a hand pause explains itself; the server sends no reason for one
    const handPause = waitingLabel(progress({ status: 'paused' }));
    expect(handPause?.text).toBe('Paused · 731 still to send');
    expect(handPause?.kind).toBe('routine');
  });

  it('spells out the contact count when a multi-item sequence makes it differ from the message count', () => {
    // a 2-item sequence: 731 pending ROWS is really ~366 pending PEOPLE
    expect(
      waitingLabel(progress({ status: 'paused', contacts: { sent: 150, skipped: 5, failed: 1, pending: 366 } }))?.text,
    ).toBe('Paused · 731 still to send (366 contacts)');
    expect(
      waitingLabel(progress({ status: 'cancelled', contacts: { sent: 150, skipped: 5, failed: 1, pending: 366 } }))?.text,
    ).toBe('Stopped · 731 never sent (366 contacts)');
  });

  it('says nothing while it is simply running, or once it is finished', () => {
    expect(waitingLabel(progress())).toBe(null);
    expect(waitingLabel(progress({ status: 'done', pending: 0 }))).toBe(null);
    // a batch pause already in the past is not something to announce
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(waitingLabel(progress({ status: 'pending', nextRunAt: past }))).toBe(null);
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
