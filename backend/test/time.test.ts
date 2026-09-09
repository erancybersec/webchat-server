import { describe, expect, it } from 'vitest';
import { atClockOnDate, dayWindow, isActiveDay, nextActiveMoment } from '../src/services/time.js';

describe('isActiveDay', () => {
  it('treats an absent/empty gate as every day', () => {
    const d = new Date(2026, 7, 19); // some Wednesday
    expect(isActiveDay(undefined, d)).toBe(true);
    expect(isActiveDay([], d)).toBe(true);
  });
  it('only allows a day-of-week in the list', () => {
    const wed = new Date(2026, 7, 19); // day-of-week 3
    expect(isActiveDay([wed.getDay()], wed)).toBe(true);
    expect(isActiveDay([(wed.getDay() + 1) % 7], wed)).toBe(false);
  });
});

describe('dayWindow', () => {
  const wed = new Date(2026, 7, 19);
  it('falls back to the rule\'s own pauseAt/resumeAt with no override', () => {
    expect(dayWindow({ pauseAt: '21:00', resumeAt: '09:00' }, wed)).toEqual({
      pauseAt: '21:00',
      resumeAt: '09:00',
    });
  });
  it("uses that day's override where one exists", () => {
    expect(
      dayWindow(
        { pauseAt: '21:00', resumeAt: '09:00', dayHours: { [wed.getDay()]: { pauseAt: '18:00' } } },
        wed,
      ),
    ).toEqual({ pauseAt: '18:00', resumeAt: '09:00' }); // resumeAt still falls back
  });
  it('a null/absent rule has no hours at all', () => {
    expect(dayWindow(null, wed)).toEqual({ pauseAt: undefined, resumeAt: undefined });
  });
});

describe('atClockOnDate', () => {
  it('sets the time on the SAME calendar day, never rolling forward', () => {
    const d = new Date(2026, 7, 19, 23, 0, 0);
    const out = atClockOnDate(d, '09:00');
    expect(out.getDate()).toBe(19);
    expect(out.getHours()).toBe(9);
    expect(out.getMinutes()).toBe(0);
  });
});

describe('nextActiveMoment', () => {
  it("returns that day's own resumeAt when the next active day has an hour window", () => {
    const from = new Date(2026, 7, 19, 10, 0, 0);
    const targetDay = (from.getDay() + 3) % 7;
    const next = nextActiveMoment(
      { activeDays: [targetDay], pauseAt: '21:00', resumeAt: '09:00' },
      from,
    );
    expect(next).not.toBeNull();
    expect(next!.getDay()).toBe(targetDay);
    expect(next!.getHours()).toBe(9);
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
  });

  it('returns midnight for the next active day when it has no hour window at all', () => {
    const from = new Date(2026, 7, 19, 10, 0, 0);
    const targetDay = (from.getDay() + 1) % 7;
    const next = nextActiveMoment({ activeDays: [targetDay] }, from);
    expect(next).not.toBeNull();
    expect(next!.getDay()).toBe(targetDay);
    expect(next!.getHours()).toBe(0);
    expect(next!.getMinutes()).toBe(0);
  });

  it('returns null when the next active day needs a human Continue', () => {
    const from = new Date(2026, 7, 19, 10, 0, 0);
    const targetDay = (from.getDay() + 1) % 7;
    // an hour window with no resumeAt = manual continue, even day-to-day
    const next = nextActiveMoment({ activeDays: [targetDay], pauseAt: '21:00' }, from);
    expect(next).toBeNull();
  });

  it('skips over days not in the list', () => {
    const from = new Date(2026, 7, 19, 10, 0, 0);
    const skip = (from.getDay() + 1) % 7;
    const target = (from.getDay() + 2) % 7;
    const next = nextActiveMoment({ activeDays: [target] }, from);
    expect(next!.getDay()).not.toBe(skip);
    expect(next!.getDay()).toBe(target);
  });
});
