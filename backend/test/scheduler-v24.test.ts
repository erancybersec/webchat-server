import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { BlacklistStore } from '../src/services/blacklist.js';
import { JobStore } from '../src/services/jobs.js';
import { ContactNameResolver } from '../src/services/contacts.js';
import {
  firstName,
  lastName,
  personalizeItem,
  substituteVars,
  usesWaName,
} from '../src/services/personalize.js';
import {
  inQuietHours,
  nextOccurrence,
  quietHoursEnd,
  Scheduler,
  type JobProgress,
  type SchedulerConfig,
} from '../src/services/scheduler.js';
import { Sender } from '../src/services/sender.js';
import { FakeEvo } from './helpers.js';

const PAST = new Date(Date.now() - 60_000).toISOString();
const textItem = { type: 'text', data: { text: 'hello' } };

const BASE_CFG: SchedulerConfig = {
  pollMs: 60_000,
  delayMinMs: 0,
  delayMaxMs: 0,
  maxOverdueMin: 0,
  sendMaxAttempts: 3,
};

describe('personalize', () => {
  const vars = (name: string, waName = '') => ({ name, waName });

  it('substitutes {{name}} and {{name|fallback}}', () => {
    expect(substituteVars('Hi {{name}}!', vars('Dana'))).toBe('Hi Dana!');
    expect(substituteVars('Hi {{ name }}!', vars('Dana'))).toBe('Hi Dana!');
    expect(substituteVars('Hi {{name|friend}}!', vars(''))).toBe('Hi friend!');
    expect(substituteVars('Hi {{name|}}!', vars(''))).toBe('Hi !');
    expect(substituteVars('no placeholders', vars('Dana'))).toBe('no placeholders');
  });

  it('{{wa_name}} is its own tag with its own fallback', () => {
    expect(substituteVars('Hi {{wa_name}}!', vars('Dana', 'Dana'))).toBe('Hi Dana!');
    expect(substituteVars('Hi {{ wa_name | friend }}!', vars('Dana', ''))).toBe('Hi friend!');
    expect(substituteVars('{{name}} / {{wa_name}}', vars('Table', 'Profile'))).toBe('Table / Profile');
  });

  it('firstName keeps the given name only', () => {
    expect(firstName('דנה כהן')).toBe('דנה');
    expect(firstName('Dana')).toBe('Dana');
    expect(firstName('  Dana   Cohen  ')).toBe('Dana');
    expect(firstName('Cohen, Dana')).toBe('Cohen'); // no reordering, just no comma
    expect(firstName('')).toBe('');
    expect(firstName('   ')).toBe('');
    expect(firstName('+972501234567')).toBe('+972501234567');
  });

  it('lastName keeps the family name only', () => {
    expect(lastName('דנה כהן')).toBe('כהן');
    expect(lastName('  Dana   Cohen  ')).toBe('Cohen');
    expect(lastName('Dana Miriam Cohen')).toBe('Cohen');
    expect(lastName('Dana')).toBe('Dana'); // one word: no separate surname
    expect(lastName('')).toBe('');
    expect(lastName('   ')).toBe('');
  });

  it('slices each name source three ways', () => {
    const v = { name: 'דנה כהן', waName: 'Tal Levi' };
    expect(substituteVars('{{first_name}}', v)).toBe('דנה');
    expect(substituteVars('{{last_name}}', v)).toBe('כהן');
    expect(substituteVars('{{full_name}}', v)).toBe('דנה כהן');
    expect(substituteVars('{{wa_first_name}}', v)).toBe('Tal');
    expect(substituteVars('{{wa_last_name}}', v)).toBe('Levi');
    expect(substituteVars('{{wa_full_name}}', v)).toBe('Tal Levi');
    expect(substituteVars('היי {{first_name}} {{last_name}}!', v)).toBe('היי דנה כהן!');
  });

  it('{{name}} / {{wa_name}} stay aliases of the first-name tags', () => {
    const v = { name: 'דנה כהן', waName: 'Tal Levi' };
    expect(substituteVars('{{name}}', v)).toBe(substituteVars('{{first_name}}', v));
    expect(substituteVars('{{wa_name}}', v)).toBe(substituteVars('{{wa_first_name}}', v));
    expect(substituteVars('היי {{name}}!', v)).toBe('היי דנה!');
  });

  it('every tag takes its own fallback; agent_name stays whole', () => {
    const empty = { name: '  ', waName: '' };
    expect(substituteVars('Hi {{first_name|friend}}!', empty)).toBe('Hi friend!');
    expect(substituteVars('Hi {{last_name|there}}!', empty)).toBe('Hi there!');
    expect(substituteVars('Hi {{full_name|you}}!', empty)).toBe('Hi you!');
    expect(substituteVars('Hi {{ wa_last_name | pal }}!', empty)).toBe('Hi pal!');
    expect(
      substituteVars('{{first_name}} — {{agent_name}}', {
        name: 'דנה כהן',
        waName: '',
        agentName: 'דנה כהן',
      }),
    ).toBe('דנה — דנה כהן');
  });

  it('usesWaName detects every wa_* tag (gates the contact fetch)', () => {
    expect(usesWaName([{ type: 'text', data: { text: 'hi {{wa_name}}' } }])).toBe(true);
    expect(usesWaName([{ type: 'text', data: { text: 'hi {{wa_name|pal}}' } }])).toBe(true);
    expect(usesWaName([{ type: 'text', data: { text: 'hi {{wa_first_name}}' } }])).toBe(true);
    expect(usesWaName([{ type: 'text', data: { text: 'hi {{ wa_last_name | pal }}' } }])).toBe(true);
    expect(usesWaName([{ type: 'text', data: { text: 'hi {{wa_full_name}}' } }])).toBe(true);
    // the operator-supplied name needs no contact book
    expect(usesWaName([{ type: 'text', data: { text: 'hi {{name}}' } }])).toBe(false);
    expect(usesWaName([{ type: 'text', data: { text: 'hi {{first_name}} {{last_name}}' } }])).toBe(
      false,
    );
  });

  it('personalizes text fields but never media payloads', () => {
    const item = {
      type: 'media',
      data: { base64: 'AAA{{name}}AAA', caption: 'For {{name}}', mimetype: 'image/png' },
    };
    const out = personalizeItem(item, vars('Dana'));
    expect(out.data.caption).toBe('For Dana');
    expect(out.data.base64).toBe('AAA{{name}}AAA');
    // original untouched (the job's stored item is shared across recipients)
    expect(item.data.caption).toBe('For {{name}}');
  });

  it('returns the same object when nothing matches (no copy)', () => {
    const item = { type: 'text', data: { text: 'plain' } };
    expect(personalizeItem(item, vars('Dana'))).toBe(item);
  });
});

describe('quiet-hours math', () => {
  const at = (h: number, m = 0) => new Date(2026, 5, 12, h, m);
  it('same-day window', () => {
    expect(inQuietHours(at(13), '12:00', '14:00')).toBe(true);
    expect(inQuietHours(at(11), '12:00', '14:00')).toBe(false);
    expect(inQuietHours(at(14), '12:00', '14:00')).toBe(false);
  });
  it('overnight window', () => {
    expect(inQuietHours(at(23), '21:00', '08:00')).toBe(true);
    expect(inQuietHours(at(7, 59), '21:00', '08:00')).toBe(true);
    expect(inQuietHours(at(12), '21:00', '08:00')).toBe(false);
  });
  it('zero-length or malformed windows never match', () => {
    expect(inQuietHours(at(13), '12:00', '12:00')).toBe(false);
    expect(inQuietHours(at(13), 'bogus', '14:00')).toBe(false);
  });
  it('quietHoursEnd lands on today or tomorrow as needed', () => {
    expect(quietHoursEnd(at(23), '08:00').getTime()).toBe(at(8).getTime() + 86_400_000);
    expect(quietHoursEnd(at(6), '08:00').getTime()).toBe(at(8).getTime());
  });
});

describe('nextOccurrence', () => {
  it('steps daily/weekly past "after"', () => {
    const from = new Date(2026, 0, 1, 9, 0);
    expect(nextOccurrence(from, 'daily', new Date(2026, 0, 3, 12, 0)).getTime()).toBe(
      new Date(2026, 0, 4, 9, 0).getTime(),
    );
    expect(nextOccurrence(from, 'weekly', from).getTime()).toBe(new Date(2026, 0, 8, 9, 0).getTime());
  });
  it('monthly clamps to short months instead of rolling over', () => {
    const jan31 = new Date(2026, 0, 31, 9, 0);
    expect(nextOccurrence(jan31, 'monthly', jan31).getTime()).toBe(
      new Date(2026, 1, 28, 9, 0).getTime(),
    );
  });
});

describe('Scheduler v2.4 behaviors', () => {
  let db: Db;
  let jobs: JobStore;
  let blacklist: BlacklistStore;
  let evo: FakeEvo;
  let events: Array<{ event: string; data: JobProgress }>;

  const makeScheduler = (cfg: Partial<SchedulerConfig> = {}) =>
    new Scheduler(
      jobs,
      new Sender(evo, blacklist),
      { ...BASE_CFG, ...cfg },
      () => {},
      (event, data) => events.push({ event, data: data as JobProgress }),
      new ContactNameResolver(evo),
    );

  beforeEach(() => {
    db = openDb(':memory:');
    jobs = new JobStore(db);
    blacklist = new BlacklistStore(db);
    evo = new FakeEvo();
    events = [];
  });
  afterEach(() => db.close());

  it('personalizes per recipient from the job recipient names', async () => {
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [
        { id: '972521111111', name: 'Dana' },
        { id: '972522222222' },
      ],
      items: [{ type: 'text', data: { text: 'Hi {{name|there}}!' } }],
    });
    await makeScheduler().tick();
    const byNumber = Object.fromEntries(evo.calls.map((c) => [c.body.number, c.body.text]));
    expect(byNumber['972521111111']).toBe('Hi Dana!');
    expect(byNumber['972522222222']).toBe('Hi there!');
  });

  it('resolves {{wa_name}} from the contact book, one fetch per run', async () => {
    evo.contacts = [{ id: '972521111111@s.whatsapp.net', pushName: 'Riki Profile' }];
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [{ id: '972521111111', name: 'Dana Table' }, { id: '972522222222' }],
      items: [{ type: 'text', data: { text: '{{name|x}} / {{wa_name|stranger}}' } }],
    });
    await makeScheduler().tick();

    const byNumber = Object.fromEntries(
      evo.calls.filter((c) => c.body?.number).map((c) => [c.body.number, c.body.text]),
    );
    // each tag keeps its own source, and both greet by first name only
    expect(byNumber['972521111111']).toBe('Dana / Riki');
    expect(byNumber['972522222222']).toBe('x / stranger'); // not in the contact book
    // the contact book was fetched exactly once for the whole run
    expect(evo.calls.filter((c) => c.endpoint.startsWith('/chat/findContacts/'))).toHaveLength(1);
  });

  it('does not touch the contact book when no item uses {{wa_name}}', async () => {
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [{ id: '972521111111', name: 'Dana' }],
      items: [{ type: 'text', data: { text: 'hi {{name}}' } }],
    });
    await makeScheduler().tick();
    expect(evo.calls.some((c) => c.endpoint.startsWith('/chat/findContacts/'))).toBe(false);
  });

  it('a failed contact fetch degrades {{wa_name}} to its fallback', async () => {
    const origCall = evo.call.bind(evo);
    evo.call = async (endpoint, ...rest) => {
      if (endpoint.startsWith('/chat/findContacts/'))
        return { status: 500, ok: false, text: 'boom', contentType: 'application/json' };
      return origCall(endpoint, ...rest);
    };
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [{ id: '972521111111' }],
      items: [{ type: 'text', data: { text: 'hi {{wa_name|friend}}' } }],
    });
    await makeScheduler().tick();
    const sent = evo.calls.find((c) => c.body?.number);
    expect(sent!.body.text).toBe('hi friend');
    expect(jobs.byId('j1')!.status).toBe('done');
  });

  it('stores the Evolution message id on sent ledger rows and acks update them', async () => {
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: [{ id: '972521111111' }], items: [textItem] });
    await makeScheduler().tick();
    const send = jobs.allSends('j1')[0]!;
    expect(send.messageId).toBe('msg-1');
    expect(send.deliveredAt).toBeNull();

    expect(jobs.markAck('msg-1', 'delivered')).toBe(1);
    expect(jobs.allSends('j1')[0]!.deliveredAt).not.toBeNull();

    jobs.markAck('msg-1', 'read');
    const after = jobs.allSends('j1')[0]!;
    expect(after.readAt).not.toBeNull();
    expect(jobs.markAck('unknown-id', 'read')).toBe(0);
  });

  it('emits JOB_PROGRESS during the run and a final done event', async () => {
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [{ id: '972521111111' }, { id: '972522222222' }],
      items: [textItem],
    });
    await makeScheduler().tick();
    expect(events.length).toBeGreaterThanOrEqual(3); // start, per-send, final
    const final = events.at(-1)!.data;
    expect(events.every((e) => e.event === 'JOB_PROGRESS')).toBe(true);
    expect(final).toMatchObject({ jobId: 'j1', total: 2, sent: 2, done: true, status: 'done' });
  });

  it('defers a due scheduled job during quiet hours instead of running it', async () => {
    const now = new Date();
    const fmt = (d: Date) =>
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    // a window that is active right now and ends in one hour
    const quietStart = fmt(new Date(now.getTime() - 3_600_000));
    const quietEnd = fmt(new Date(now.getTime() + 3_600_000));
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: [{ id: '972521111111' }], items: [textItem] });

    await makeScheduler({ quietEnabled: true, quietStart, quietEnd }).tick();

    expect(evo.calls).toHaveLength(0);
    const deferred = jobs.byId('j1')!;
    expect(deferred.status).toBe('pending');
    expect(new Date(deferred.scheduledAt).getTime()).toBeGreaterThan(now.getTime());
  });

  it('lets immediate "send now" jobs bypass quiet hours', async () => {
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      type: 'immediate',
      recipients: [{ id: '972521111111' }],
      items: [textItem],
    });
    await makeScheduler({ quietEnabled: true, quietStart: '00:00', quietEnd: '23:59' }).tick();
    expect(evo.calls).toHaveLength(1);
    expect(jobs.byId('j1')!.status).toBe('done');
  });

  it('rolls a recurring job forward to the next future occurrence', async () => {
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [{ id: '972521111111' }],
      items: [textItem],
      repeat: { freq: 'daily' },
    });
    await makeScheduler({ recurringEnabled: true }).tick();

    expect(jobs.byId('j1')!.status).toBe('done');
    const next = jobs.all().find((j) => j.id !== 'j1')!;
    expect(next).toBeDefined();
    expect(next.status).toBe('pending');
    expect(next.repeat).toEqual({ freq: 'daily' });
    const expected = new Date(PAST).getTime() + 86_400_000;
    expect(new Date(next.scheduledAt).getTime()).toBe(expected);
    expect(next.recipients).toEqual([{ id: '972521111111' }]);
  });

  it('does NOT roll forward when recurring is disabled (the default)', async () => {
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [{ id: '972521111111' }],
      items: [textItem],
      repeat: { freq: 'daily' },
    });
    await makeScheduler().tick();
    expect(jobs.byId('j1')!.status).toBe('done');
    expect(jobs.all()).toHaveLength(1); // no clone
  });

  it('ends a recurring series at its until date', async () => {
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [{ id: '972521111111' }],
      items: [textItem],
      repeat: { freq: 'daily', until: new Date(Date.now() + 3_600_000).toISOString() },
    });
    await makeScheduler({ recurringEnabled: true }).tick();
    expect(jobs.all()).toHaveLength(1); // next would land after until — series over
  });

  it('a cancelled occurrence ends the series', async () => {
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [{ id: '972521111111' }],
      items: [textItem],
      repeat: { freq: 'daily' },
    });
    // cancel lands right after the send goes out
    const origCall = evo.call.bind(evo);
    evo.call = async (...args) => {
      const res = await origCall(...args);
      jobs.setStatus('j1', 'cancelled');
      return res;
    };
    await makeScheduler({ recurringEnabled: true }).tick();
    expect(jobs.byId('j1')!.status).toBe('cancelled');
    expect(jobs.all()).toHaveLength(1);
  });

  it('a missed occurrence still schedules the next one', async () => {
    const wayPast = new Date(Date.now() - 3_600_000).toISOString();
    jobs.upsert({
      id: 'j1',
      scheduledAt: wayPast,
      recipients: [{ id: '972521111111' }],
      items: [textItem],
      repeat: { freq: 'daily' },
    });
    await makeScheduler({ recurringEnabled: true, maxOverdueMin: 5 }).tick();
    expect(jobs.byId('j1')!.status).toBe('missed');
    const next = jobs.all().find((j) => j.id !== 'j1')!;
    expect(next.status).toBe('pending');
    expect(new Date(next.scheduledAt).getTime()).toBeGreaterThan(Date.now());
  });
});
