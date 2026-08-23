import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type NotifyPrefs } from '../lib/api';
import {
  currentPushEndpoint,
  disableNotifications,
  enableNotifications,
  notificationsEnabled,
  notificationsSupported,
} from '../lib/notify';
import { Switch } from './Switch';
import { useToast } from './Toast';

const DEFAULTS: NotifyPrefs = {
  groups: true,
  dms: true,
  jobsEnded: true,
  jobsFailuresOnly: false,
  quietEnabled: false,
  quietStart: '21:00',
  quietEnd: '08:00',
  keywords: '',
};

/** A labelled row with a description and a trailing control (switch/input). */
function Row({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="text-sm font-medium text-gray-700">{title}</p>
        {hint && <p className="text-xs text-gray-500">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

/**
 * Per-person notification preferences. Self-contained so it can be mounted both
 * in admin Settings and on the (everyone-visible) Profile tab. The master
 * enable + push subscription is per-device (localStorage + a push_subscriptions
 * row); the category/quiet/keyword prefs are per-agent (saved to /api/notify-prefs).
 */
export function NotificationPrefsCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(notificationsEnabled);
  const [testing, setTesting] = useState(false);

  const prefsQ = useQuery({ queryKey: ['notifyPrefs'], queryFn: api.notifyPrefs.get });
  const p = prefsQ.data ?? DEFAULTS;

  // keywords get a local buffer so typing doesn't fire a save per keystroke
  const [keywords, setKeywords] = useState('');
  useEffect(() => {
    if (prefsQ.data) setKeywords(prefsQ.data.keywords);
  }, [prefsQ.data]);

  const save = useMutation({
    mutationFn: (patch: Partial<NotifyPrefs>) => api.notifyPrefs.save(patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: ['notifyPrefs'] });
      const prev = qc.getQueryData<NotifyPrefs>(['notifyPrefs']);
      qc.setQueryData<NotifyPrefs>(['notifyPrefs'], { ...(prev ?? DEFAULTS), ...patch });
      return { prev };
    },
    onError: (e, _patch, ctx) => {
      if (ctx?.prev) qc.setQueryData(['notifyPrefs'], ctx.prev);
      toast(String((e as Error).message), 'err');
    },
    onSuccess: (data) => qc.setQueryData(['notifyPrefs'], data),
  });

  async function toggleEnabled() {
    if (enabled) {
      disableNotifications();
      setEnabled(false);
      toast('Notifications off');
      return;
    }
    const ok = await enableNotifications();
    setEnabled(ok);
    if (ok) toast('Notifications on — you get pinged when the app is in the background');
    else toast('Permission denied — allow notifications in the browser settings', 'err');
  }

  async function sendTest() {
    if (!notificationsEnabled()) return toast('Turn notifications on first', 'err');
    setTesting(true);
    try {
      const ep = await currentPushEndpoint();
      const { sent } = await api.push.test(ep ?? undefined);
      if (sent > 0) toast('Test notification sent — check your device');
      else toast('No subscribed device — toggle notifications off and on again', 'err');
    } catch (e) {
      toast(String((e as Error).message), 'err');
    } finally {
      setTesting(false);
    }
  }

  const keywordsDirty = keywords.trim() !== p.keywords;

  return (
    <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div>
        <h3 className="text-sm font-semibold text-gray-700">Notifications</h3>
        <p className="text-xs text-gray-500">
          Get a system notification for incoming messages and finished jobs — including when the app
          is closed (Web Push). On a phone, install the app first (browser menu → “Add to Home
          Screen”); iPhone requires iOS 16.4+ and the installed app. These preferences are yours
          alone.
        </p>
      </div>

      <Row
        title="Enable notifications"
        hint="Asks the browser for permission and registers this device for push."
      >
        {notificationsSupported() ? (
          <Switch on={enabled} onToggle={() => void toggleEnabled()} label="Enable notifications" />
        ) : (
          <span className="text-xs text-amber-600">Not supported in this browser</span>
        )}
      </Row>

      <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
        <button
          onClick={() => void sendTest()}
          disabled={testing || !enabled}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:border-wa hover:bg-green-50 hover:text-wa-dark disabled:opacity-50"
        >
          {testing ? 'Sending…' : 'Send test notification'}
        </button>
        <span className="text-xs text-gray-400">
          Confirms your device actually shows a push (a blocked channel silently drops it).
        </span>
      </div>

      <div className="space-y-3 border-t border-gray-100 pt-3">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">What pings me</p>
        <Row title="Group messages" hint="Incoming messages in WhatsApp groups.">
          <Switch
            on={p.groups}
            disabled={save.isPending}
            onToggle={() => save.mutate({ groups: !p.groups })}
            label="Group messages"
          />
        </Row>
        <Row title="Direct messages" hint="Incoming 1:1 chats.">
          <Switch
            on={p.dms}
            disabled={save.isPending}
            onToggle={() => save.mutate({ dms: !p.dms })}
            label="Direct messages"
          />
        </Row>
        <Row title="Job finished" hint="When a scheduled or bulk job you created completes.">
          <Switch
            on={p.jobsEnded}
            disabled={save.isPending}
            onToggle={() => save.mutate({ jobsEnded: !p.jobsEnded })}
            label="Job finished"
          />
        </Row>
        {p.jobsEnded && (
          <Row title="Only when a job had failures" hint="Skip the ping for clean, fully-sent jobs.">
            <Switch
              on={p.jobsFailuresOnly}
              disabled={save.isPending}
              onToggle={() => save.mutate({ jobsFailuresOnly: !p.jobsFailuresOnly })}
              label="Only failed jobs"
            />
          </Row>
        )}
      </div>

      <div className="space-y-3 border-t border-gray-100 pt-3">
        <Row
          title="Quiet hours"
          hint="Mute notifications during this window (keyword alerts still come through)."
        >
          <Switch
            on={p.quietEnabled}
            disabled={save.isPending}
            onToggle={() => save.mutate({ quietEnabled: !p.quietEnabled })}
            label="Quiet hours"
          />
        </Row>
        {p.quietEnabled && (
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-gray-600">From</label>
              <input
                type="time"
                value={p.quietStart}
                onChange={(e) => save.mutate({ quietStart: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-gray-600">Until</label>
              <input
                type="time"
                value={p.quietEnd}
                onChange={(e) => save.mutate({ quietEnd: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
        )}
      </div>

      <div className="space-y-2 border-t border-gray-100 pt-3">
        <label className="block text-sm font-medium text-gray-700">Keyword alerts</label>
        <p className="text-xs text-gray-500">
          Comma-separated words. A message containing any of them always notifies you — even if its
          category is muted or you’re in quiet hours.
        </p>
        <div className="flex gap-2">
          <input
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="urgent, refund, ביטול"
            dir="auto"
            className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          {keywordsDirty && (
            <button
              onClick={() => save.mutate({ keywords: keywords.trim() })}
              disabled={save.isPending}
              className="shrink-0 rounded-lg bg-wa px-4 py-2 text-sm font-semibold text-white hover:bg-wa-dark disabled:opacity-50"
            >
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
